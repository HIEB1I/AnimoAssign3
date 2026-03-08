from __future__ import annotations
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Iterable, List, Literal, Optional, Tuple

from fastapi import APIRouter, Body, HTTPException, Query, Depends
from pymongo import ReturnDocument

from dataclasses import dataclass
import math
from dataclasses import dataclass, asdict
from datetime import datetime, time
from functools import lru_cache
from motor.motor_asyncio import AsyncIOMotorClient
from collections import defaultdict
import csv
import io
import uuid
import re

from ..main import db

# In-app bell notifications (same pattern as Faculty Service)
from ..Notifications import create_notification

async def _ensure_user_gmail_address(user_id: str, db) -> None:
    """Best-effort: ensure users.gmail is populated for email notifications.

    In some deployments, Faculty/Chair user records have their address stored in
    `email` (or similar) while `gmail` is blank. The notification email sender
    typically looks for `gmail` first; when it's missing, the in-app notification
    still works but the Gmail notification can be skipped.

    This helper backfills users.gmail from the best available email field without
    changing any other behavior. It is safe to call repeatedly.
    """

    uid = (user_id or "").strip()
    if not uid:
        return

    try:
        user = await db["users"].find_one(
            {"user_id": uid},
            {"_id": 0, "gmail": 1, "email": 1, "dlsu_email": 1, "google_email": 1},
        ) or {}
        gmail = str(user.get("gmail") or "").strip()
        if gmail:
            return

        # Try common fallbacks
        fallback = (
            str(user.get("email") or "").strip()
            or str(user.get("dlsu_email") or "").strip()
            or str(user.get("google_email") or "").strip()
        )
        if not fallback:
            return

        await db["users"].update_one(
            {"user_id": uid, "$or": [{"gmail": {"$exists": False}}, {"gmail": ""}, {"gmail": None}]},
            {"$set": {"gmail": fallback}},
        )
    except Exception:
        # Never fail a workflow due to best-effort backfill.
        return

def get_db():
    return db

COL_USERS = "users"
COL_STAFF = "staff_profiles"
COL_FACULTY = "faculty_profiles"
COL_ASSIGN = "faculty_assignments"
COL_SECTIONS = "sections"
COL_SECTIONS_SUBMITTED = "sections_submitted"
COL_APO_SUBMISSIONS = "apo_scheduling_submissions"
COL_OM_SUBMIT_WINDOWS = "om_submit_windows"
COL_DEPARTMENTS = "departments"
COL_ROLE_ASSIGN = "role_assignments"
COL_SCHED = "section_schedules"
COL_ROOMS = "rooms"
COL_COURSES = "courses"
COL_TERMS = "terms"
COL_DEPTS = "departments"
COL_CAMPUSES = "campuses"
COL_LEAVES = "leaves"
COL_PREFERENCES = "faculty_preferences"
COL_FACULTY_LOADS = "faculty_loads"

# OM <-> Faculty proposal + RFC collections
COL_LOAD_PROPOSALS = "faculty_load_proposals"
COL_LOAD_RFC = "faculty_rfc"

async def _special_class_section_ids(term_id: str, db) -> set[str]:
    """Collect section_ids that belong to Special Class records for a term.

    Requirement: OM_LoadAssignment must *not* reflect Special Classes in its
    load assignment tables.

    Special Class rows live in the `special_class` collection and may reference
    a section via different legacy shapes:
      - special_class.section_id
      - special_class.assignment_id -> faculty_assignments.section_id
      - schedule_id within schedule_entries / slot1 / slot2 -> section_schedules.section_id

    We resolve all of the above best-effort and return a set of section_ids.
    """

    term_id = (term_id or "").strip()
    if not term_id:
        return set()

    try:
        sc_rows = await db.get_collection("special_class").find(
            {"term_id": term_id},
            {
                "_id": 0,
                "section_id": 1,
                "assignment_id": 1,
                "schedule_entries": 1,
                "slot1": 1,
                "slot2": 1,
            },
        ).to_list(None)
    except Exception:
        sc_rows = []

    if not sc_rows:
        return set()

    out: set[str] = set()
    asg_ids: set[str] = set()
    sched_ids: set[str] = set()

    def _s(x: Any) -> str:
        return (str(x).strip() if x is not None else "")

    def _collect_schedule_ids(val: Any) -> None:
        if not val:
            return
        if isinstance(val, dict):
            sid = _s(val.get("schedule_id") or val.get("id"))
            if sid:
                sched_ids.add(sid)
            return
        if isinstance(val, list):
            for e in val:
                if isinstance(e, dict):
                    sid = _s(e.get("schedule_id") or e.get("id"))
                    if sid:
                        sched_ids.add(sid)

    for r in sc_rows:
        sid = _s(r.get("section_id"))
        if sid:
            out.add(sid)

        aid = _s(r.get("assignment_id"))
        if aid:
            asg_ids.add(aid)

        _collect_schedule_ids(r.get("schedule_entries"))
        _collect_schedule_ids(r.get("slot1"))
        _collect_schedule_ids(r.get("slot2"))

    # Resolve assignment_id -> section_id
    if asg_ids:
        try:
            asg_docs = await db.get_collection(COL_ASSIGN).find(
                {"assignment_id": {"$in": sorted(asg_ids)}, "is_archived": {"$ne": True}},
                {"_id": 0, "assignment_id": 1, "section_id": 1},
            ).to_list(None)
            for a in asg_docs or []:
                sid = _s(a.get("section_id"))
                if sid:
                    out.add(sid)
        except Exception:
            pass

    # Resolve schedule_id -> section_id
    if sched_ids:
        try:
            sched_docs = await db.get_collection(COL_SCHED).find(
                {"schedule_id": {"$in": sorted(sched_ids)}},
                {"_id": 0, "schedule_id": 1, "section_id": 1},
            ).to_list(None)
            for s in sched_docs or []:
                sid = _s(s.get("section_id"))
                if sid:
                    out.add(sid)
        except Exception:
            pass

    return out

def _campus_name_to_id(val: str) -> str:
    """Map Campus column values to campus_id.

    Supported values (case-insensitive):
      - Manila  -> CMPS0001
      - Laguna  -> CMPS0002

    Returns an empty string when the input is blank.
    Raises ValueError for non-blank unknown values.
    """
    s = (val or "").strip()
    if not s:
        return ""

    s_norm = s.casefold()
    if s_norm == "manila":
        return "CMPS0001"
    if s_norm == "laguna":
        return "CMPS0002"

    raise ValueError(f"Invalid Campus value: {s}")

def _section_to_campus_id(section_code: str) -> str:
    """APO routing by Section prefix.

    - If section starts with S or G -> Manila (CMPS0001)
    - If section starts with XX or XC -> Laguna (CMPS0002)
    """
    s = (section_code or "").strip().upper()
    if not s:
        return ""
    if s.startswith("XX") or s.startswith("XC"):
        return "CMPS0002"
    if s.startswith("S") or s.startswith("G"):
        return "CMPS0001"
    return ""


async def _section_campus_id_for_row(
    sid: str,
    section_code: str,
    term_id: str,
    db,
) -> str:
    """Best-effort campus_id resolver for OM Load Assignment rows.

    Priority:
      1) sections_submitted.campus_id (snapshot/source of truth for OM grid)
      2) sections.campus_id (canonical)
      3) infer from section_code prefix (legacy routing)

    Returns "" when it cannot be resolved. Never raises.
    """

    sid = (sid or "").strip()
    section_code = (section_code or "").strip()
    term_id = (term_id or "").strip()

    if sid and term_id:
        try:
            ss = await db[COL_SECTIONS_SUBMITTED].find_one(
                {"term_id": term_id, "section_id": sid},
                {"_id": 0, "campus_id": 1},
            ) or {}
            cid = str(ss.get("campus_id") or "").strip()
            if cid:
                return cid
        except Exception:
            pass

    if sid:
        try:
            sec = await db[COL_SECTIONS].find_one(
                {"section_id": sid},
                {"_id": 0, "campus_id": 1},
            ) or {}
            cid = str(sec.get("campus_id") or "").strip()
            if cid:
                return cid
        except Exception:
            pass

    try:
        return _section_to_campus_id(section_code)
    except Exception:
        return ""


async def _apo_user_ids_for_campus(campus_id: str, db) -> list[str]:
    """Return APO user_ids who are scoped to the given campus.

    BUGFIX (notifications): do NOT assume a fixed APO role_id.
    In this codebase, APO modules resolve the APO role_id dynamically from
    `user_roles` (role_type == "APO") and then read `role_assignments`.
    If we hardcode ROLE0004 and the actual APO role_id differs, we will
    resolve 0 APO recipients and NO in-app/Gmail notification will be sent.

    We mirror APO_CourseOfferings.apo_scope()'s resolution logic here and add a
    safe fallback to users.campus_id for legacy accounts without explicit scope.
    """

    campus_id = (campus_id or "").strip().upper()
    if not campus_id:
        return []

    # Prefer dynamic APO role_id from user_roles (mirrors APO modules).
    ROLE_APO = ""
    try:
        role_doc = await db.get_collection("user_roles").find_one(
            {"role_type": {"$regex": "APO", "$options": "i"}},
            {"_id": 0, "role_id": 1},
        )
        ROLE_APO = str((role_doc or {}).get("role_id") or "").strip()
    except Exception:
        ROLE_APO = ""

    # Backward compatibility: older deployments used a fixed ID.
    if not ROLE_APO:
        ROLE_APO = "ROLE0004"

    def _scope_has_campus(scope_val) -> bool:
        if not scope_val:
            return False
        scopes = scope_val if isinstance(scope_val, list) else [scope_val]
        for s in scopes:
            if not isinstance(s, dict):
                continue
            typ = str(s.get("type") or s.get("scope_type") or "").strip().lower()
            sid = str(s.get("id") or s.get("scope_id") or s.get("campus_id") or "").strip().upper()
            if sid == campus_id and (typ in ("campus", "campuses", "") or "campus" in typ):
                return True
        return False

    out: set[str] = set()

    # 1) Role-assignment scoped users (primary behavior)
    try:
        docs = (
            await db.get_collection("role_assignments")
            .find({"role_id": ROLE_APO}, {"_id": 0, "user_id": 1, "scope": 1})
            .to_list(None)
        )
    except Exception:
        docs = []

    for d in docs or []:
        uid = str(d.get("user_id") or "").strip()
        if not uid:
            continue
        if _scope_has_campus(d.get("scope")):
            out.add(uid)

    # 2) Legacy fallback: some APO accounts only have users.campus_id set
    # (no explicit campus scope in role_assignments).
    try:
        cur = db.get_collection(COL_USERS).find(
            {"role": {"$regex": "APO", "$options": "i"}, "campus_id": campus_id},
            {"_id": 0, "user_id": 1},
        )
        async for u in cur:
            uid = str(u.get("user_id") or "").strip()
            if uid:
                out.add(uid)
    except Exception:
        pass

    return sorted(list(out))

async def _all_apo_user_ids(db) -> list[str]:
    """Return all APO user_ids (best-effort).

    Used as a last-resort fallback when campus-scoped routing is not configured.
    Sources:
    1) role_assignments via APO role_id from user_roles (role_type == "APO")
    2) legacy users.role == "APO"
    """
    uids: set[str] = set()

    # 1) role_assignments for APO role
    try:
        apo_role = await db["user_roles"].find_one({"role_type": "APO"}, {"_id": 0, "role_id": 1})
        apo_role_id = (apo_role or {}).get("role_id")
        if apo_role_id:
            cur = db["role_assignments"].find({"role_id": apo_role_id}, {"_id": 0, "user_id": 1})
            async for r in cur:
                uid = (r or {}).get("user_id")
                if uid:
                    uids.add(str(uid))
    except Exception:
        pass

    # 2) legacy users.role field
    try:
        cur2 = db["users"].find({"role": {"$regex": r"\bAPO\b", "$options": "i"}}, {"_id": 0, "user_id": 1})
        async for r in cur2:
            uid = (r or {}).get("user_id")
            if uid:
                uids.add(str(uid))
    except Exception:
        pass

    return sorted(uids)

async def _find_course_by_code(course_code: str, db) -> dict:
    """Find a course by course_code (supports string or array storage)."""
    import re as _re
    cc = (course_code or "").strip()
    if not cc:
        return {}
    q = {"$or": [
        {"course_code": {"$regex": rf"^{_re.escape(cc)}$", "$options": "i"}},
        {"course_code": [cc]},
        {"course_code": {"$in": [cc]}},
        {"course_code": {"$elemMatch": {"$regex": rf"^{_re.escape(cc)}$", "$options": "i"}}},
    ]}
    return await db[COL_COURSES].find_one(q, {"_id": 0}) or {}

async def _loadassignment_department_ids(user_id: str, db) -> List[str]:
    """Department scope for users who can access Load Assignment.

    Historically, Load Assignment was restricted to Office Manager (ROLE0006)
    and the backend used only that role's scope to determine visible sections.

    However, the UI reuses the same Load Assignment module for other roles that
    should see the *exact* same department data (e.g., Department Chair and GS
    Coordinator), especially when they are mapped to the same department.

    This helper resolves department_ids from role_assignments.scope for any
    Load-Assignment-eligible role.
    """

    uid = (user_id or "").strip()
    if not uid:
        return []

    # Resolve role_ids dynamically from user_roles to avoid hard-coding IDs.
    # Keep spelling variants for legacy data ("Deparment Chair").
    eligible_patterns = [
        r"^Office\s*Manager$",
        r"^Department\s*Chair$",
        r"^Deparment\s*Chair$",
        r"^GS\s*Coordinator$",
    ]

    role_ids: List[str] = []
    try:
        or_terms = [{"role_type": {"$regex": p, "$options": "i"}} for p in eligible_patterns]
        roles = await db.get_collection("user_roles").find(
            {"$or": or_terms},
            {"_id": 0, "role_id": 1},
        ).to_list(50)
        for rdoc in roles or []:
            rid = str((rdoc or {}).get("role_id") or "").strip()
            if rid and rid not in role_ids:
                role_ids.append(rid)
    except Exception:
        # If user_roles is unavailable, fall back to known IDs.
        role_ids = ["ROLE0006", "ROLE0002", "ROLE0007"]

    dept_ids: List[str] = []
    try:
        cur = db.get_collection("role_assignments").find(
            {"user_id": uid, "role_id": {"$in": role_ids}},
            {"_id": 0, "scope": 1},
        )
        async for ra in cur:
            for sc in ((ra or {}).get("scope") or []):
                if isinstance(sc, dict) and sc.get("type") == "department":
                    did = str(sc.get("id") or "").strip()
                    if did and did not in dept_ids:
                        dept_ids.append(did)
    except Exception:
        pass

    # Fallback: staff_profiles may store department_id/dept_id even when role
    # assignments are incomplete. This keeps CHAIR/GS Coordinator functional.
    if not dept_ids:
        try:
            sp = await db.get_collection(COL_STAFF).find_one(
                {"user_id": uid},
                {"_id": 0, "department_id": 1, "dept_id": 1},
            ) or {}
            did = str(sp.get("department_id") or sp.get("dept_id") or "").strip()
            if did:
                dept_ids.append(did)
        except Exception:
            pass

    return dept_ids

def _iso(dt):
    try:
        return dt.isoformat()
    except Exception:
        return str(dt)

# RFC state machine
RFC_TERMINAL = {"ACCEPTED", "APPROVED", "REJECTED"}
RFC_OPEN = {"OPEN", "NEEDS_OM", "NEEDS_FACULTY", "open"}

def _normalize_rfc_doc(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Backwards-compatible normalization for RFC docs.

    Legacy shape:
      {status: 'open'|'closed', thread: [{from, message, created_at}], decision, locked}

    New shape:
      {status: 'NEEDS_OM'|'NEEDS_FACULTY'|'ACCEPTED'|'APPROVED'|'REJECTED',
       messages: [{sender_role, sender_user_id, message, created_at}]}.
    """
    if not doc:
        return doc

    # Ensure rfc_id exists
    if not doc.get('rfc_id'):
        # stable-ish id: RFC + last 8 of Mongo _id when present
        mid = str(doc.get('_id') or '')
        suffix = (mid[-8:] if mid else '')
        doc['rfc_id'] = f"RFC{suffix}" if suffix else f"RFC{__import__('uuid').uuid4().hex[:10].upper()}"

    # Normalize messages
    msgs = []
    if isinstance(doc.get('messages'), list):
        for m in doc['messages']:
            if not isinstance(m, dict):
                continue
            msgs.append({
                'sender_role': m.get('sender_role') or m.get('from') or 'faculty',
                'sender_user_id': m.get('sender_user_id') or m.get('user_id') or '',
                'message': m.get('message') or m.get('text') or '',
                'created_at': m.get('created_at') or m.get('createdAt') or None,
            })
    elif isinstance(doc.get('thread'), list):
        for m in doc['thread']:
            if not isinstance(m, dict):
                continue
            role = (m.get('from') or m.get('sender_role') or '').lower() or 'faculty'
            msgs.append({
                'sender_role': role,
                'sender_user_id': '',
                'message': m.get('message') or m.get('text') or '',
                'created_at': m.get('created_at') or m.get('createdAt') or None,
            })

    doc['messages'] = msgs

    # Normalize status
    st = (doc.get('status') or '').upper()
    if st in RFC_TERMINAL or st in ("NEEDS_OM", "NEEDS_FACULTY", "OPEN"):
        doc['status'] = st
    elif st == 'CLOSED':
        dec = (doc.get('decision') or '').lower()
        doc['status'] = 'APPROVED' if dec == 'approve' else ('REJECTED' if dec == 'reject' else 'APPROVED')
    elif st == 'OPEN':
        # infer whose turn
        last_role = (msgs[-1].get('sender_role') if msgs else 'faculty')
        last_role = (last_role or '').lower()
        doc['status'] = 'NEEDS_OM' if last_role == 'faculty' else 'NEEDS_FACULTY'
    else:
        doc['status'] = 'NEEDS_OM'

    # locked flag
    if doc['status'] in RFC_TERMINAL:
        doc['locked'] = True

    return doc

async def _dept_name_by_id(dept_id: str, db) -> str:
    """Best-effort department name lookup used for notification copy."""
    if not dept_id:
        return ""
    d = await db[COL_DEPTS].find_one(
        {
            "$or": [
                {"department_id": dept_id},
                {"dept_id": dept_id},
                {"id": dept_id},
            ]
        },
        {"_id": 0, "dept_name": 1, "department_name": 1, "name": 1, "dept_code": 1},
    ) or {}
    return (d.get("dept_name") or d.get("department_name") or d.get("name") or "").strip()

async def _chair_user_ids_for_department_id(department_id: str, db) -> List[str]:
    """
    Resolve chair user_id(s) for a department.

    Priority:
      1) staff_profiles where position_title contains "chair" (case-insensitive)
         - match by department_id/dept_id
         - fallback match by dept_name/department_name if ids not present
      2) role_assignments for that department (active-ish)
      3) role-based resolution (user_roles role_type contains "chair") joined via role_assignments
      4) SAFE FALLBACK: notify ANY chair in the system (staff_profiles chair OR role_assignments chair-role),
         so notifications are not silently dropped.
    """
    if not department_id:
        return []

    dept_name = await _dept_name_by_id(department_id, db)

    ids: List[str] = []

    # 1) staff_profiles by department_id/dept_id
    try:
        cur = db[COL_STAFF].find(
            {
                "$or": [{"department_id": department_id}, {"dept_id": department_id}],
                "position_title": {"$regex": "chair", "$options": "i"},
            },
            {"_id": 0, "user_id": 1},
        )
        async for d in cur:
            if d.get("user_id"):
                ids.append(d["user_id"])
    except Exception:
        pass

    # 1b) staff_profiles by dept name (fallback)
    if not ids and dept_name:
        try:
            cur_name = db[COL_STAFF].find(
                {
                    "$or": [
                        {"dept_name": dept_name},
                        {"department_name": dept_name},
                        {"department": dept_name},
                        {"dept": dept_name},
                    ],
                    "position_title": {"$regex": "chair", "$options": "i"},
                },
                {"_id": 0, "user_id": 1},
            )
            async for d in cur_name:
                if d.get("user_id"):
                    ids.append(d["user_id"])
        except Exception:
            pass

    # 2) role_assignments fallback (dept-scoped)
    if not ids:
        try:
            cur2 = db[COL_ROLE_ASSIGN].find(
                {
                    "$or": [{"department_id": department_id}, {"dept_id": department_id}],
                    "is_active": {"$in": [True, None]},
                },
                {"_id": 0, "user_id": 1},
            )
            async for d in cur2:
                if d.get("user_id"):
                    ids.append(d["user_id"])
        except Exception:
            pass

    # 3) role-based resolution: user_roles(role_type contains chair) -> role_assignments(role_id in ...)
    if not ids:
        try:
            chair_roles = await db["user_roles"].find(
                {"role_type": {"$regex": "chair", "$options": "i"}},
                {"_id": 0, "role_id": 1},
            ).to_list(100)
            chair_role_ids = [r.get("role_id") for r in chair_roles if r.get("role_id")]

            if chair_role_ids:
                cur3 = db[COL_ROLE_ASSIGN].find(
                    {
                        "role_id": {"$in": chair_role_ids},
                        "$or": [{"department_id": department_id}, {"dept_id": department_id}],
                        "is_active": {"$in": [True, None]},
                    },
                    {"_id": 0, "user_id": 1},
                )
                async for d in cur3:
                    if d.get("user_id"):
                        ids.append(d["user_id"])
        except Exception:
            pass

    # 3b) optional: department doc may store chair email -> resolve to users.user_id
    if not ids:
        try:
            dept_doc = await db[COL_DEPTS].find_one(
                {"$or": [{"department_id": department_id}, {"dept_id": department_id}]},
                {"_id": 0, "chair_email": 1, "chairEmail": 1, "email_chair": 1},
            ) or {}
            chair_email = (dept_doc.get("chair_email") or dept_doc.get("chairEmail") or dept_doc.get("email_chair") or "").strip()
            if chair_email:
                u = await db[COL_USERS].find_one(
                    {"email": {"$regex": f"^{re.escape(chair_email)}$", "$options": "i"}},
                    {"_id": 0, "user_id": 1},
                )
                if u and u.get("user_id"):
                    ids.append(u["user_id"])
        except Exception:
            pass

    # 4) SAFE FALLBACK: notify ANY chair (system-wide) so we never silently drop notifs
    if not ids:
        # 4a) any staff_profile chair
        try:
            cur_any = db[COL_STAFF].find(
                {"position_title": {"$regex": "chair", "$options": "i"}},
                {"_id": 0, "user_id": 1},
            ).limit(25)
            async for d in cur_any:
                if d.get("user_id"):
                    ids.append(d["user_id"])
        except Exception:
            pass

    if not ids:
        # 4b) any role_assignment tied to a chair role_id
        try:
            chair_roles = await db["user_roles"].find(
                {"role_type": {"$regex": "chair", "$options": "i"}},
                {"_id": 0, "role_id": 1},
            ).to_list(100)
            chair_role_ids = [r.get("role_id") for r in chair_roles if r.get("role_id")]
            if chair_role_ids:
                cur_any2 = db[COL_ROLE_ASSIGN].find(
                    {
                        "role_id": {"$in": chair_role_ids},
                        "is_active": {"$in": [True, None]},
                    },
                    {"_id": 0, "user_id": 1},
                ).limit(25)
                async for d in cur_any2:
                    if d.get("user_id"):
                        ids.append(d["user_id"])
        except Exception:
            pass

    # unique
    seen = set()
    out: List[str] = []
    for x in ids:
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return out

async def get_office_manager_department(db, user_id: str) -> str | None:
    role = await db.role_assignments.find_one({
        "user_id": user_id,
        "role_id": "ROLE0006",
        "scope.type": "department",
    })

    if not role:
        return None

    for scope in role.get("scope", []):
        if scope.get("type") == "department":
            return scope.get("id")

    return None

async def _infer_department_id_from_rows(rows: List[Dict[str, Any]], db) -> Optional[str]:
    """Best-effort department_id inference for OM forward/update.

    Tries, in order:
      1) row.department_id / row.dept_id fields (various key spellings)
      2) lookup sections by section_id then take the most common department_id/dept_id
    """
    if not rows:
        return None

    # 1) direct hints in payload rows
    for r in rows:
        for k in ("department_id", "dept_id", "departmentId", "deptId"):
            v = r.get(k)
            if v:
                return str(v).strip()

    # 2) infer via section_id -> sections.department_id
    sec_ids: List[str] = []
    for r in rows:
        sid = r.get("section_id") or r.get("sectionId") or r.get("sec_id") or r.get("secId")
        if sid:
            sec_ids.append(str(sid).strip())

    if not sec_ids:
        return None

    # Fetch matching sections
    docs = await db[COL_SECTIONS].find({"section_id": {"$in": list(set(sec_ids))}}, {"_id": 0, "department_id": 1, "dept_id": 1}).to_list(None)
    if not docs:
        return None

    counts: Dict[str, int] = {}
    for d in docs:
        did = d.get("department_id") or d.get("dept_id")
        if did:
            did = str(did).strip()
            counts[did] = counts.get(did, 0) + 1

    if not counts:
        return None

    # return most common
    return max(counts.items(), key=lambda kv: kv[1])[0]

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)

async def _next_load_id(db) -> str:
    """
    Find the last load_id in faculty_loads and return the next one, e.g.
    LOAD0004 -> LOAD0005. If none, start at LOAD0001.
    """
    rows = await db[COL_FACULTY_LOADS].find(
        {}, {"_id": 0, "load_id": 1}
    ).sort("load_id", -1).to_list(1)

    last = (rows[0]["load_id"] if rows and rows[0].get("load_id") else None)
    if not last or not last.startswith("LOAD"):
        return "LOAD0001"

    num_part = last.replace("LOAD", "")
    try:
        n = int(num_part) + 1
    except ValueError:
        n = 1
    return f"LOAD{n:04d}"

async def _active_term() -> Dict[str, Any]:
    # 1) find the current anchor (must be is_current=True)
    cur = await db[COL_TERMS].find_one(
        {"is_current": True},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )
    if not cur:
        return {}

    # 2) get the next term in chronological order
    nxt = await db[COL_TERMS].find(
        {
            "$or": [
                {"acad_year_start": {"$gt": cur["acad_year_start"]}},
                {
                    "acad_year_start": cur["acad_year_start"],
                    "term_number": {"$gt": cur["term_number"]},
                },
            ]
        },
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    ).sort([("acad_year_start", 1), ("term_number", 1)]).to_list(1)

    return (nxt[0] if nxt else {})

def _fmt_time(hhmm: Optional[Any]) -> str:
    """
    Return a string time in HH:MM. Accepts:
      - "07:30" (kept as-is)
      - "730"  or "0730" (normalized to "07:30")
      - numeric 730 (normalized to "07:30")
    Blanks/invalid -> "".
    """
    if hhmm in (None, "", 0):
        return ""

    s = str(hhmm).strip()

    # Already proper "HH:MM" → keep it
    if re.fullmatch(r"\d{1,2}:\d{2}", s):
        return s

    # Remove non-digits and normalize
    digits = re.sub(r"\D", "", s)
    if len(digits) == 3:
        digits = "0" + digits
    if len(digits) == 4:
        return f"{digits[:2]}:{digits[2:]}"

    # Anything else invalid
    return ""

# DEBUG function
async def _faculty_on_leave_map(db, active_term_id: str) -> set[str]:
    """
    Returns set of faculty_id who are on approved + active leave
    where active_term_id falls within [start_term_id, end_term_id] inclusive,
    based on term ordering from terms collection.
    """

    if not active_term_id:
        return set()

    # Fetch all terms and build an index map for ordering
    term_list = await db["terms"].find(
        {},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    ).sort([("acad_year_start", 1), ("term_number", 1)]).to_list(None)

    term_ids = [t.get("term_id") for t in term_list if t.get("term_id")]
    if not term_ids:
        return set()

    term_index = {tid: i for i, tid in enumerate(term_ids)}
    active_idx = term_index.get(active_term_id)
    if active_idx is None:
        # Active term_id not recognized → safest behavior is "no one is on leave for this term"
        return set()

    # Pull active + approved leaves (only fields we need)
    leaves = await db["leaves"].find(
        {"approval_status": "APPROVED", "is_active": True},
        {"_id": 0, "faculty_id": 1, "start_term_id": 1, "end_term_id": 1},
    ).to_list(None)

    blocked: set[str] = set()

    for lv in leaves:
        fid = str(lv.get("faculty_id") or "").strip()
        if not fid:
            continue

        start_tid = lv.get("start_term_id")
        end_tid = lv.get("end_term_id")

        # If either term id is missing or not in our known ordering, skip safely
        s = term_index.get(start_tid)
        e = term_index.get(end_tid)
        if s is None or e is None:
            continue

        # Normalize if accidentally reversed
        if s > e:
            s, e = e, s

        if s <= active_idx <= e:
            blocked.add(fid)

    return blocked

AA_DEBUG_KAC = True

def _aa_kac_log(msg: str):
    if AA_DEBUG_KAC:
        print(msg)

# --- APO-set deadline window (OM/GS schedule + faculty encoding) -------------

def _parse_iso_dt(s: str) -> Optional[datetime]:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None

async def _infer_campus_id_for_user(user_id: str, db) -> Optional[str]:
    """Best-effort campus resolver for OM/GS users."""

    uid = (user_id or "").strip()
    if not uid:
        return None

    # 1) role_assignments scope campus / department -> departments.campus_id
    # IMPORTANT: prefer role_assignments over users.campus_id because many
    # deployments store users.campus_id as a *campus name* (e.g., "Manila"),
    # which won't match sections.campus_id / campuses.campus_id (e.g., "CMPS0001").
    try:
        ras = await db[COL_ROLE_ASSIGN].find(
            {"user_id": uid},
            {"_id": 0, "scope": 1, "updated_at": 1, "created_at": 1, "role_assignment_id": 1},
        ).sort([("updated_at", -1), ("created_at", -1), ("role_assignment_id", -1)]).to_list(25)

        def _scope_items(scope_val: Any) -> list[dict]:
            if not scope_val:
                return []
            if isinstance(scope_val, dict):
                return [scope_val]
            if isinstance(scope_val, list):
                return [x for x in scope_val if isinstance(x, dict)]
            return []

        for ra in ras or []:
            for s in _scope_items(ra.get("scope")):
                stype = str(s.get("type") or s.get("scope_type") or "").strip().lower()
                sid = str(s.get("id") or s.get("scope_id") or s.get("campus_id") or "").strip()
                if sid and (stype in ("campus", "campuses") or "campus" in stype):
                    return await _normalize_campus_id(sid, db)

                if sid and ("dept" in stype or stype == "department"):
                    d = await db[COL_DEPARTMENTS].find_one(
                        {"department_id": sid},
                        {"_id": 0, "campus_id": 1},
                    ) or {}
                    cid2 = str(d.get("campus_id") or "").strip()
                    if cid2:
                        return await _normalize_campus_id(cid2, db)
    except Exception:
        pass

    # 2) users.campus_id (legacy fallback)
    try:
        u = await db[COL_USERS].find_one({"user_id": uid}, {"_id": 0, "campus_id": 1}) or {}
        cid = str(u.get("campus_id") or "").strip()
        if cid:
            return await _normalize_campus_id(cid, db)
    except Exception:
        pass

    return None

async def _normalize_campus_id(raw: Optional[str], db) -> Optional[str]:
    """Normalize a campus identifier to campuses.campus_id when possible.

    Some datasets store campus as a name ("Manila"), others as an id ("CMPS0001").
    Returning a canonical campuses.campus_id ensures:
      - window lookups match,
      - sections/submissions queries match,
      - reminders can resolve recipients by campus.
    """

    v = str(raw or "").strip()
    if not v:
        return None

    # Direct match
    try:
        doc = await db["campuses"].find_one({"campus_id": v}, {"_id": 0, "campus_id": 1})
        if doc and doc.get("campus_id"):
            return str(doc["campus_id"]).strip()
    except Exception:
        pass

    # Case-normalized match
    try:
        doc = await db["campuses"].find_one({"campus_id": v.upper()}, {"_id": 0, "campus_id": 1})
        if doc and doc.get("campus_id"):
            return str(doc["campus_id"]).strip()
    except Exception:
        pass

    # Exact campus_name match
    try:
        doc = await db["campuses"].find_one(
            {"campus_name": {"$regex": f"^{re.escape(v)}$", "$options": "i"}},
            {"_id": 0, "campus_id": 1},
        )
        if doc and doc.get("campus_id"):
            return str(doc["campus_id"]).strip()
    except Exception:
        pass

    # Heuristic: contains match
    try:
        doc = await db["campuses"].find_one(
            {"campus_name": {"$regex": re.escape(v), "$options": "i"}},
            {"_id": 0, "campus_id": 1},
        )
        if doc and doc.get("campus_id"):
            return str(doc["campus_id"]).strip()
    except Exception:
        pass

    return v

async def _get_om_submit_window(term_id: str, campus_id: str, db) -> Optional[Dict[str, str]]:
    term_id = str(term_id or "").strip()
    cid_raw = str(campus_id or "").strip()
    cid = (await _normalize_campus_id(cid_raw, db)) or cid_raw

    doc = await db[COL_OM_SUBMIT_WINDOWS].find_one(
        {"term_id": term_id, "campus_id": cid},
        {"_id": 0, "openISO": 1, "deadlineISO": 1},
    )

    # Backward-compat: some windows were stored using campus_name ("Manila")
    # instead of campuses.campus_id ("CMPS0001").
    if not doc and cid_raw and cid_raw != cid:
        doc = await db[COL_OM_SUBMIT_WINDOWS].find_one(
            {"term_id": term_id, "campus_id": cid_raw},
            {"_id": 0, "openISO": 1, "deadlineISO": 1},
        )

    if not doc and cid:
        try:
            camp = await db["campuses"].find_one(
                {"campus_id": cid}, {"_id": 0, "campus_name": 1}
            ) or {}
            cname = str(camp.get("campus_name") or "").strip()
            if cname:
                doc = await db[COL_OM_SUBMIT_WINDOWS].find_one(
                    {"term_id": term_id, "campus_id": {"$regex": f"^{re.escape(cname)}$", "$options": "i"}},
                    {"_id": 0, "openISO": 1, "deadlineISO": 1},
                )
        except Exception:
            pass

    # Global fallback (campus_id == "")
    if not doc:
        doc = await db[COL_OM_SUBMIT_WINDOWS].find_one(
            {"term_id": term_id, "campus_id": ""},
            {"_id": 0, "openISO": 1, "deadlineISO": 1},
        )

    if not doc:
        return None
    return {
        "openISO": str(doc.get("openISO") or ""),
        "deadlineISO": str(doc.get("deadlineISO") or ""),
    }

async def _has_apo_submission(term_id: str, campus_id: str, db) -> bool:
    term_id = str(term_id or "").strip()
    cid = (await _normalize_campus_id(campus_id, db)) or str(campus_id or "").strip()

    # Primary: apo_scheduling_submissions
    try:
        sub = await db[COL_APO_SUBMISSIONS].find_one(
            {"term_id": term_id, "campus_id": cid},
            {"_id": 0, "submit_count": 1},
        ) or {}
        if int(sub.get("submit_count") or 0) > 0:
            return True
    except Exception:
        pass

    # Fallback: any section marked submitted_for_scheduling
    try:
        hit = await db[COL_SECTIONS].find_one(
            {"term_id": term_id, "campus_id": cid, "submitted_for_scheduling": True},
            {"_id": 0, "section_id": 1},
        )
        return bool(hit)
    except Exception:
        return False

async def _infer_campus_id_from_rows(rows: List[Dict[str, Any]], db) -> Optional[str]:
    """Infer campus_id from the submitted grid rows (best-effort).

    This is used as a fallback when the OM/GS user's campus cannot be resolved
    via profile/role scope, but we still want the deadline lock to apply.
    """

    if not rows:
        return None

    # 1) Direct campus fields in row payload
    for k in ("campus_id", "campusId", "campus"):
        for r in rows:
            v = str((r or {}).get(k) or "").strip()
            if v:
                return await _normalize_campus_id(v, db)

    # 2) Resolve via section_id -> sections.campus_id
    sids: List[str] = []
    for r in rows:
        sid = str((r or {}).get("id") or (r or {}).get("section_id") or "").strip()
        if sid:
            sids.append(sid)
    if not sids:
        return None

    # Keep query bounded
    sids = sids[:200]

    counts: Dict[str, int] = {}
    try:
        cur = db[COL_SECTIONS].find(
            {"section_id": {"$in": sids}},
            {"_id": 0, "campus_id": 1},
        )
        async for s in cur:
            cid = str(s.get("campus_id") or "").strip()
            if not cid:
                continue
            counts[cid] = counts.get(cid, 0) + 1
    except Exception:
        return None

    if not counts:
        return None

    # Choose the most common campus among sections
    best = max(counts.items(), key=lambda kv: kv[1])[0]
    return await _normalize_campus_id(best, db)

def _deadline_passed(window: Optional[Dict[str, str]]) -> bool:
    if not window:
        return False
    deadline_dt = _parse_iso_dt(window.get("deadlineISO") or "")
    if not deadline_dt:
        return False
    return datetime.now(timezone.utc) >= deadline_dt

# --- Day-pair normalization helpers -----------------------------------------
DAY_PAIR = {
    "M": "H",  # Monday ↔ Thursday
    "H": "M",
    "T": "F",  # Tuesday ↔ Friday
    "F": "T",
    "W": "S",  # Wednesday ↔ Saturday
    "S": "W",
}
DAY_ORDER_INDEX = {"M": 0, "H": 1, "T": 0, "F": 1, "W": 0, "S": 1}

def _normalize_pair_order(
    d1: str | None, b1: str | None, e1: str | None,
    d2: str | None, b2: str | None, e2: str | None,
):
    """
    Rules:
      1) If only slot2 is filled, promote it to slot1.
      2) If both days exist and are a valid pair (M/H, T/F, W/S) but in reverse order,
         swap so day1 is the pair's canonical 'first' (M,T,W).
      3) If both days exist but not a valid pair, keep as-is (we only normalize valid pairs).
      4) If both days are same, keep slot1 and blank slot2.
    """
    # 1) promote slot2 -> slot1 when slot1 is empty
    if not d1 and d2:
        d1, b1, e1, d2, b2, e2 = d2, b2, e2, None, None, None
        return d1, b1, e1, d2, b2, e2

    # If both empty or only slot1 present, nothing to do
    if not d1 or not d2:
        return d1, b1, e1, d2, b2, e2

    D1, D2 = (d1 or "").upper(), (d2 or "").upper()

    # 4) identical days -> drop slot2
    if D1 == D2:
        return d1, b1, e1, None, None, None

    # Check if they are a recognized pair
    is_pair = DAY_PAIR.get(D1) == D2 or DAY_PAIR.get(D2) == D1
    if not is_pair:
        return d1, b1, e1, d2, b2, e2  # unrelated days; leave as-is

    # Make sure day1 is the canonical 'first' (M/T/W indices are 0)
    i1 = DAY_ORDER_INDEX.get(D1)
    i2 = DAY_ORDER_INDEX.get(D2)
    if i1 is None or i2 is None:
        return d1, b1, e1, d2, b2, e2

    # If slot1 is the 'second' of the pair, swap
    if i1 == 1 and i2 == 0:
        d1, b1, e1, d2, b2, e2 = d2, b2, e2, d1, b1, e1

    return d1, b1, e1, d2, b2, e2

def _derive_mode(section: Dict[str, Any],
                 scheds: List[Dict[str, Any]],
                 course: Dict[str, Any],
                 pref_mode: Optional[str] = None) -> str:
    """
    Decide effective mode (optimized rule):
      1) If section.mode is explicitly set → use it.
      2) Else if there’s an assigned faculty preference → use it.
      3) Else → return "" (unset). We do NOT infer from schedules or course.
    """
    def _norm(x: Any) -> str:
        return str(x or "").strip().upper()

    m = _norm(section.get("mode"))
    if m in {"HYB", "FOL", "ONLINE", "ONSITE"}:
        return m

    pm = _norm(pref_mode)
    if pm in {"HYB", "FOL", "ONLINE", "ONSITE"}:
        return pm

    return ""  # leave unset when no section mode and no faculty preference

def _looks_like_room_id(v: str | None) -> bool:
    s = (v or "").strip().upper()
    return s.startswith("ROOM")

def _parse_time_str(v: Any) -> str:
    """Best-effort normalize time to HH:MM (24h). Leaves unknown formats untouched."""
    s = str(v or "").strip()
    if not s:
        return ""

    # common inputs: "08:00", "8:00", "8:00 AM", "8:00AM"
    for fmt in ("%H:%M", "%H:%M:%S", "%I:%M %p", "%I:%M%p", "%I %p", "%I%p"):
        try:
            dt = datetime.strptime(s.upper().replace(" ", "" if "%p" in fmt and "% " not in fmt else " "), fmt)
            return dt.strftime("%H:%M")
        except Exception:
            continue

    # if it's already a short numeric like 800 or 0800
    digits = re.sub(r"\D", "", s)
    if len(digits) in (3, 4) and digits.isdigit():
        try:
            hh = int(digits[:-2])
            mm = int(digits[-2:])
            if 0 <= hh <= 23 and 0 <= mm <= 59:
                return f"{hh:02d}:{mm:02d}"
        except Exception:
            pass

    return s

def _norm_header(h: str) -> str:
    return re.sub(r"\s+", " ", str(h or "").strip()).lower()

async def _next_seq_id(db, collection: str, field: str, prefix: str, width: int = 4, attempts: int = 50) -> str:
    """Return next ID like 'SEC0001' / 'CRS0001'."""
    last = await db[collection].find_one(
        {field: {"$regex": rf"^{re.escape(prefix)}\d+$"}},
        sort=[(field, -1)],
    )
    n = 0
    if last and isinstance(last.get(field), str):
        m = re.match(rf"^{re.escape(prefix)}(\d+)$", last[field])
        if m:
            n = int(m.group(1))
    for _ in range(attempts):
        n += 1
        cand = f"{prefix}{n:0{width}d}"
        exists = await db[collection].find_one({field: cand}, {"_id": 1})
        if not exists:
            return cand
    # last resort: random
    return f"{prefix}{uuid.uuid4().hex[:width].upper()}"

def _sch_id_from_sec(section_id: str, slot: int = 1) -> str:
    m = re.match(r"^SEC(\d+)$", (section_id or "").strip().upper())
    if m:
        return f"SCH{int(m.group(1)):04d}-{int(slot):02d}"
    return f"SCH-{section_id}-{int(slot)}"

def _asg_id_from_sec(section_id: str) -> str:
    m = re.match(r"^SEC(\d+)$", (section_id or "").strip().upper())
    if m:
        return f"ASG{int(m.group(1)):04d}"
    return f"ASG{uuid.uuid4().hex[:10].upper()}"

async def _resolve_room_id(db, room_value: str) -> str | None:
    v = (room_value or "").strip()
    if not v:
        return None
    if _looks_like_room_id(v):
        return v
    # try match by room_number
    doc = await db[COL_ROOMS].find_one(
        {"room_number": {"$regex": rf"^{re.escape(v)}$", "$options": "i"}},
        {"_id": 0, "room_id": 1},
    )
    return (doc or {}).get("room_id")

async def _find_or_create_course_from_csv(db, course_code: str, course_title: str, units: Any) -> str:
    """Return course_id. Creates a minimal SHS course if not found."""
    cc = (course_code or "").strip()
    if not cc:
        # stable but unique
        cc = f"SHS-{uuid.uuid4().hex[:6].upper()}"

    # courses.course_code can be string or array
    q = {
        "$or": [
            {"course_code": {"$regex": rf"^{re.escape(cc)}$", "$options": "i"}},
            {"course_code": [cc]},
            {"course_code": {"$elemMatch": {"$regex": rf"^{re.escape(cc)}$", "$options": "i"}}},
        ]
    }
    existing = await db[COL_COURSES].find_one(q, {"_id": 0, "course_id": 1})
    if existing and existing.get("course_id"):
        return str(existing["course_id"])

    cid = await _next_seq_id(db, COL_COURSES, "course_id", "CRS", 4)
    # best-effort units
    try:
        u = float(units) if units not in (None, "") else 0.0
        u = int(u) if float(u).is_integer() else u
    except Exception:
        u = units

    await db[COL_COURSES].insert_one(
        {
            "course_id": cid,
            "course_code": cc,
            "course_title": (course_title or "").strip(),
            "units": u,
            "type_of_course": "SHS",
            "type": "SHS",
            "created_at": datetime.utcnow(),
            "updated_at": datetime.utcnow(),
        }
    )
    return cid

def _preferred_cap_for(ctx, fid: str) -> int:
    pref = (getattr(ctx, "prefs_by_faculty", {}) or {}).get(fid, {}) or {}
    return int(pref.get("preferred_units") or pref.get("load_units") or 12)

async def _notify_apo_room_allocation_ready(
    *,
    db,
    om_user_id: str,
    term_id: str,
    faculty_id: str,
    course_code: str,
    section_code: str,
) -> None:
    # Resolve section_id + campus for routing (best-effort)
    campus_id = _section_to_campus_id(section_code)
    section_id = ""

    try:
        course_doc = await _find_course_by_code(course_code, db)
        course_id = str(course_doc.get("course_id") or "").strip()

        if course_id and term_id:
            sec = await db[COL_SECTIONS].find_one(
                {"term_id": term_id, "course_id": course_id, "section_code": section_code},
                {"_id": 0, "section_id": 1, "campus_id": 1},
            ) or {}
            section_id = str(sec.get("section_id") or "").strip()
            campus_id = str(sec.get("campus_id") or "").strip() or campus_id
    except Exception:
        pass

    if not campus_id:
        return

    apo_uids = await _apo_user_ids_for_campus(campus_id, db)
    if not apo_uids:
        return

    meta = {
        # APO frontend route (see APO sidebar)
        "route": "/apo/roomallocation",
        "kind": "om_room_allocation_ready",
        "term_id": term_id,
        "campus_id": campus_id,
        "section_id": section_id,
        "faculty_id": faculty_id,
        "course_code": course_code,
        "section": section_code,
    }
    details = f"Ready for room allocation: {course_code} – {section_code} (Faculty: {faculty_id})"

    for uid in apo_uids:
        await _ensure_user_gmail_address(uid, db)
        await create_notification(
            user_id=uid,
            title="Room allocation needed",
            details=details,
            meta=meta,
            send_email=True,
            email_from_user_id=om_user_id,
        )

async def _fetch_rows(user_id: str, term_id: str, db, archived_view: bool = False) -> Dict[str, Any]:
    dept_ids = await _loadassignment_department_ids(user_id, db)
    if not dept_ids:
        return {"rows": []}

    # Exclude Special Class sections from OM Load Assignment.
    # Special Classes are handled in their own workflow (special_class collection)
    # and must not appear in the OM load assignment table.
    special_section_ids = await _special_class_section_ids(term_id, db)

    # Primary source of truth for Load Assignment rows is `sections_submitted`.
    # However, some legacy deployments/terms may only have section offerings in `sections`
    # (or were migrated before `sections_submitted` existed). This caused Archived Loads
    # to appear empty for those older terms.
    #
    # Fix: try `sections_submitted` first; if there are no rows for the requested term,
    # fall back to `sections` for that term.

    # For Archived Loads, include legacy rows where `submitted_for_scheduling` is missing/null.
    # For the active/planning term, keep the strict behavior: submitted_for_scheduling=True.
    submitted_match: Dict[str, Any]
    if archived_view:
        submitted_match = {
            "$or": [
                {"submitted_for_scheduling": True},
                {"submitted_for_scheduling": {"$exists": False}},
                {"submitted_for_scheduling": None},
            ]
        }
    else:
        submitted_match = {"submitted_for_scheduling": True}

    pipe: List[Dict[str, Any]] = [
        {"$match": {"term_id": term_id, **submitted_match}} if term_id else {"$match": submitted_match},

        # Filter out Special Class section_ids (best-effort). Keep this early for performance.
        ({"$match": {"section_id": {"$nin": sorted(list(special_section_ids))}}} if special_section_ids else {"$match": {}}),

        {"$lookup": {"from": COL_COURSES, "localField": "course_id", "foreignField": "course_id", "as": "course"}},
        {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": False}},
        # Dept restriction (each OM only sees their department)
        {"$match": {"course.department_id": {"$in": dept_ids}}},
        {
        "$match": {
            "$or": [
                {"course.type_of_course": {"$in": ["Major", "Foundation", "SHS", "GS"]}},
                {"course.type": {"$in": ["Major", "Foundation", "SHS", "GS"]}},]}},

        {"$lookup": {"from": COL_SCHED, "localField": "section_id", "foreignField": "section_id", "as": "scheds"}},

        # optional current assignment (0..1)
        {"$lookup": {"from": COL_ASSIGN, "localField": "section_id", "foreignField": "section_id", "as": "asg"}},
        {"$unwind": {"path": "$asg", "preserveNullAndEmptyArrays": True}},

        # join faculty + user to display name
        {"$lookup": {"from": COL_FACULTY, "localField": "asg.faculty_id", "foreignField": "faculty_id", "as": "fac"}},
        {"$unwind": {"path": "$fac", "preserveNullAndEmptyArrays": True}},

        # NEW: pull all prefs for that faculty (we'll pick the active term in Python)
        {"$lookup": {"from": COL_PREFERENCES, "localField": "asg.faculty_id", "foreignField": "faculty_id", "as": "fprefs"}},

        {"$lookup": {"from": COL_USERS, "localField": "fac.user_id", "foreignField": "user_id", "as": "u"}},
        {"$unwind": {"path": "$u", "preserveNullAndEmptyArrays": True}},

        # normalize course_code (array|string → string)
        {"$addFields": {
            "course_code_display": {
                "$cond": [
                    {"$isArray": "$course.course_code"},
                    {"$ifNull": [{"$arrayElemAt": ["$course.course_code", 0]}, ""]},
                    {"$ifNull": ["$course.course_code", ""]},
                ]
            },
            "faculty_name_display": {
                "$trim": {"input": {"$concat": [
                    {"$ifNull": ["$u.last_name", ""]},
                    {"$cond": [{"$and":[{"$ne":["$u.last_name", None]},{"$ne":["$u.first_name", None]}]}, ", ", ""]},
                    {"$ifNull": ["$u.first_name", ""]},
                ]}}
            },
        }},
        {"$sort": {"course_code": 1}},
    ]

    docs = [x async for x in db[COL_SECTIONS_SUBMITTED].aggregate(pipe)]

    # Legacy fallback: if a term has no `sections_submitted` rows, try `sections`.
    # Only do this when the primary query returns nothing to avoid duplicates.
    if term_id and not docs:
        try:
            docs = [x async for x in db[COL_SECTIONS].aggregate(pipe)]
        except Exception:
            # Best-effort only; keep existing behavior.
            docs = []

    # Preload section remarks from the canonical `sections` collection.
    # Remarks are stored in sections.remarks (not in sections_submitted).
    section_ids_for_remarks = [
        (d.get("section_id") or "").strip() for d in docs if (d.get("section_id") or "").strip()
    ]
    remarks_by_section_id: dict[str, str] = {}
    if section_ids_for_remarks:
        try:
            sec_docs = await db["sections"].find(
                {"section_id": {"$in": section_ids_for_remarks}},
                {"_id": 0, "section_id": 1, "remarks": 1},
            ).to_list(None)
            remarks_by_section_id = {
                (s.get("section_id") or "").strip(): str(s.get("remarks") or "")
                for s in (sec_docs or [])
                if (s.get("section_id") or "").strip()
            }
        except Exception:
            remarks_by_section_id = {}

    # --- Preload rooms into lookups (number + capacity) so OM table can reflect
    #     APO room/room-capacity changes without requiring manual edits. ---
    room_docs = [
        x async for x in db[COL_ROOMS].find(
            {},
            {"room_id": 1, "room_number": 1, "capacity": 1, "_id": 0}
        )
    ]

    rooms_map = {
        (r.get("room_id") or "").strip(): (r.get("room_number") or "").strip()
        for r in room_docs
    }

    rooms_capacity_map = {
        (r.get("room_id") or "").strip(): r.get("capacity")
        for r in room_docs
        if (r.get("room_id") or "").strip()
    }

    def schedule_pair(
        scheds: List[Dict[str, Any]],
        section: Dict[str, Any],
        course: Dict[str, Any],
        mode_override: Optional[str] = None,   # NEW
    ) -> Dict[str, str]:
        s1 = (scheds[0] if len(scheds) > 0 else {}) or {}
        s2 = (scheds[1] if len(scheds) > 1 else {}) or {}        

        def _get_day(s: Dict[str, Any]) -> str:
            return (s.get("day") or s.get("day_of_week") or s.get("day1") or s.get("day2") or "") or ""
        def _get_start(s: Dict[str, Any]) -> str:
            return _fmt_time(s.get("start_time") or s.get("begin") or s.get("begin1") or s.get("start"))
        def _get_end(s: Dict[str, Any]) -> str:
            return _fmt_time(s.get("end_time") or s.get("end") or s.get("end1") or s.get("finish"))
        def _room_display(s: Dict[str, Any]) -> str:
            """Show room_number if room_id exists; otherwise TBA."""
            rid = (s.get("room_id") or "").strip()
            if not rid:
                return "TBA"
            # Lookup room_number
            rn = rooms_map.get(rid)
            return rn if rn else "TBA"

        return {
            "day1": _get_day(s1),
            "begin1": _get_start(s1) or "",
            "end1": _get_end(s1) or "",
            "room1": _room_display(s1),
            "day2": _get_day(s2),
            "begin2": _get_start(s2) or "",
            "end2": _get_end(s2) or "",
            "room2": _room_display(s2),
        }

    rows_by_sid: Dict[str, Dict[str, Any]] = {}
    for d in docs:
        sid = d.get("section_id") or ""
        if not sid:
            continue

        course_doc = (d.get("course") or {})
        scheds = (d.get("scheds") or [])

        # Expose schedule_id(s) so the frontend can map back to the correct section via section_schedules.
        schedule_ids = [
            (s.get("schedule_id") or "").strip()
            for s in (scheds[:2] if isinstance(scheds, list) else [])
            if (s.get("schedule_id") or "").strip()
        ]

        # --- Faculty preference mode for current term ---
        pref_mode = ""
        fid = (d.get("asg") or {}).get("faculty_id")
        if fid:
            for p in (d.get("fprefs") or []):
                if p.get("term_id") == term_id and p.get("is_finished"):
                    pref_mode = ((p.get("mode") or {}).get("mode")
                                or p.get("preferred_mode") or "").strip().upper()
                    if pref_mode:
                        break
        
        # Compute effective mode once (section → pref → scheds → course)
        effective_mode = _derive_mode(d, scheds, course_doc, pref_mode=pref_mode or None)

        # Rooms are derived using that same mode
        pair = schedule_pair(scheds, d, course_doc, mode_override=effective_mode)

        # Display uses the effective mode
        mode_display = effective_mode

        # Capacity should reflect the section's enrollment cap (APO may edit this).
        # If enrollment_cap is missing, fall back to the assigned room capacity when available.
        cap_value = d.get("enrollment_cap", "") or ""
        if cap_value in ("", None):
            try:
                s0 = (scheds[0] if len(scheds) > 0 else {}) or {}
                rid1 = (s0.get("room_id") or "").strip()
                if rid1 and rid1 in rooms_capacity_map and rooms_capacity_map[rid1] is not None:
                    cap_value = rooms_capacity_map[rid1]
            except Exception:
                pass

        row = {
            "id": sid,
            # Used by frontend for correct mapping when saving remarks.
            # Backend resolves the section via section_schedules.schedule_id.
            "schedule_ids": schedule_ids,
            # NEW: expose course_id for KAC checks
            "course_id": course_doc.get("course_id") or d.get("course_id") or "",
            "course": d.get("course_code_display") or "",
            "title": course_doc.get("course_title", "") or "",
            "units": course_doc.get("units", "") or "",
            "section": d.get("section_code", "") or "",
            # Campus is needed for campus-specific APO deadlines (Manila vs Laguna).
            # Prefer explicit campus_id on the submitted snapshot; fall back to prefix inference.
            "campus_id": (str(d.get("campus_id") or "").strip() or _section_to_campus_id(d.get("section_code", ""))),
            # NEW: keep both faculty_id and display name so manual edits can persist correctly
            "faculty_id": (d.get("asg") or {}).get("faculty_id") or "",
            "faculty": d.get("faculty_name_display", "") or "",
            **pair,
            "capacity": cap_value,
            "mode": mode_display,
            # Prefer canonical sections.remarks, but fall back to sections_submitted.remarks
            # (needed for SHS imports which may store remarks on the submitted snapshot).
            "remarks": remarks_by_section_id.get(sid, "") or str(d.get("remarks") or ""),
            "status": (
                "Approved"
                if bool((d.get("asg") or {}).get("synced_from_faculty_service")) and (d.get("asg") or {}).get("faculty_id")
                else ("Pending" if (d.get("asg") or {}).get("faculty_id") else "Unassigned")
            ),
            "synced_from_faculty_service": bool((d.get("asg") or {}).get("synced_from_faculty_service")),
        }

        # If there is **no faculty assigned**, keep schedule/capacity/mode intact so OM can
        # assign a faculty based on the offering details coming from APO/import.
        # Only clear faculty display fields and keep status as "Unassigned".
        fid_str = (row.get("faculty_id") or "").strip()
        if not fid_str:
            row["faculty"] = ""
            row["status"] = "Unassigned"

        rows_by_sid[sid] = row

    rows = list(rows_by_sid.values())

    _flag_faculty_conflicts(rows, resolve_conflicts=False)

    # --- Overlay finalized + faculty-approved status from proposals (best-effort) ---
    # This ensures:
    #   1) Auto-assign won't "move" finalized schedules (frontend disables actions too)
    #   2) Status column shows "Approved" once faculty has approved AND the row is finalized
    try:
        proposals = await db[COL_LOAD_PROPOSALS].find(
            {"term_id": term_id},
            {"_id": 0, "faculty_id": 1, "status": 1, "locked": 1, "rows": 1},
        ).to_list(None)

        # Pending RFCs should revert an Approved row back to Pending (row-level).
        # This is crucial when OM sends additional rows to a faculty: we must NOT demote
        # previously accepted rows unless the faculty has an open RFC for that specific row.
        pending_rfc_section_ids: set[tuple[str, str]] = set()  # (faculty_id, section_id)
        try:
            rfc_docs = await db[COL_LOAD_RFC].find(
                {"term_id": term_id},
                {"_id": 0, "faculty_id": 1, "section_id": 1, "status": 1},
            ).to_list(None)
            for rfc in rfc_docs or []:
                if not isinstance(rfc, dict):
                    continue
                fid_r = str(rfc.get("faculty_id") or "").strip()
                sid_r = str(rfc.get("section_id") or "").strip()
                st_r = str(rfc.get("status") or "").strip().upper()
                if fid_r and sid_r and st_r and st_r not in RFC_TERMINAL:
                    pending_rfc_section_ids.add((fid_r, sid_r))
        except Exception:
            # Never block OM list due to RFC lookup failures.
            pending_rfc_section_ids = set()

        # faculty_id -> proposal status (header-level)
        # NOTE: Header-level status is NOT sufficient for OM row status because updating/adding
        # rows resets the header to "proposed". We still keep it for legacy behavior, but row-level
        # "finalized" flags determine whether a specific row remains Approved.
        proposal_status_by_fid: dict[str, str] = {}
        # Matching strategy (to avoid false positives):
        # 1) Prefer section_id match when present (most stable)
        # 2) Fallback to (course_code, section_code) for legacy rows that don't carry section_id
        #
        # - forwarded_*: row exists in an OM->Faculty proposal (already sent to faculty)
        # - finalized_*: row has been accepted by faculty (row-level finalized=True) OR proposal header locked
        forwarded_section_ids: set[tuple[str, str]] = set()  # (faculty_id, section_id)
        finalized_section_ids: set[tuple[str, str]] = set()  # (faculty_id, section_id)
        forwarded_keys: set[tuple[str, str, str]] = set()    # (faculty_id, course_code, section)
        finalized_keys: set[tuple[str, str, str]] = set()    # (faculty_id, course_code, section)

        for p in proposals or []:
            fid = str(p.get("faculty_id") or "").strip()
            if not fid:
                continue
            st = str(p.get("status") or "").strip().lower()
            proposal_status_by_fid[fid] = st
            locked_all = bool(p.get("locked"))

            for rr in (p.get("rows") or []):
                if not isinstance(rr, dict):
                    continue
                sid = str(rr.get("section_id") or rr.get("id") or rr.get("sectionId") or "").strip()
                course = str(rr.get("course") or rr.get("course_code") or "").strip()
                section = str(rr.get("section") or "").strip()

                # Prefer stable section_id matching when available.
                if sid:
                    forwarded_section_ids.add((fid, sid))
                    if locked_all or bool(rr.get("finalized")):
                        finalized_section_ids.add((fid, sid))

                # Legacy fallback: course+section (only if both are present)
                if course and section:
                    forwarded_keys.add((fid, course, section))
                    if locked_all or bool(rr.get("finalized")):
                        finalized_keys.add((fid, course, section))

        for r in rows:
            if not isinstance(r, dict):
                continue
            fid = str(r.get("faculty_id") or "").strip()
            sid = str(r.get("id") or r.get("section_id") or "").strip()
            course = str(r.get("course") or "").strip()
            section = str(r.get("section") or "").strip()

            # Highlight rows already forwarded to faculty (proposal exists)
            forwarded = False
            if fid and sid and (fid, sid) in forwarded_section_ids:
                forwarded = True
            elif fid and course and section and (fid, course, section) in forwarded_keys:
                forwarded = True
            if forwarded:
                r["forwarded_to_faculty"] = True

            # Finalized/locked rows stay protected from auto-assign and can be rendered as finalized.
            if fid and sid and (fid, sid) in finalized_section_ids:
                r["finalized"] = True
            elif fid and course and section and (fid, course, section) in finalized_keys:
                r["finalized"] = True

            # Faculty "Accept Schedule" must NOT lock/finalize rows.
            # However, OM should still see the row status as "Approved" once the faculty accepts.
            # IMPORTANT: When OM sends additional rows, proposal header status may be reset to
            # "proposed". Do NOT demote previously finalized/accepted rows.
            st = proposal_status_by_fid.get(fid, "")
            is_finalized_row = False
            if fid and sid and (fid, sid) in finalized_section_ids:
                is_finalized_row = True
            elif fid and course and section and (fid, course, section) in finalized_keys:
                is_finalized_row = True

            # Row-level RFC overrides approval: any open RFC for this section sets it back to Pending.
            has_open_rfc = bool(fid and sid and (fid, sid) in pending_rfc_section_ids)
            if forwarded and (is_finalized_row or st in ("approved", "accepted")) and not has_open_rfc:
                r["status"] = "Approved"
            elif has_open_rfc:
                # Keep as Pending even if finalized, until RFC is resolved.
                r["status"] = "Pending"
                r["pending_rfc"] = True
    except Exception:
        pass

    return {"rows": rows}

async def _apply_mode_and_rooms_to_rows(rows: list[dict], db):
    """
    Ensure each row has consistent mode, room1, room2, and room_type.

    This should mirror whatever you're currently doing in _approve_and_persist
    so that Save/Approve and Run all behave the same.
    """

    # Collect section_ids from rows
    section_ids = [r.get("id") for r in rows if r.get("id")]

    if not section_ids:
        return

    sections = await db["sections"].find(
        {"section_id": {"$in": section_ids}},
        {"_id": 0, "section_id": 1, "mode": 1},
    ).to_list(None)
    sections_by_id = {s["section_id"]: s for s in sections}

    for row in rows:
        # If no faculty assigned, keep the row completely “empty”
        fid = (row.get("faculty_id") or "").strip()
        if not fid:
            for k in (
                "day1", "begin1", "end1", "room1",
                "day2", "begin2", "end2", "room2",
                "mode", "room_type",
            ):
                row[k] = ""
            continue

        sec_id = row.get("id")
        sec = sections_by_id.get(sec_id) if sec_id else None

        # --- MODE ---
        # If row already has mode from UI or auto-assign, keep it.
        # Otherwise, fall back to section.mode (if any).
        if not row.get("mode"):
            if sec and sec.get("mode"):
                row["mode"] = sec["mode"]
            else:
                # default fallback (adjust if you have a different default)
                row["mode"] = "HYB"

        # --- ROOM PLACEHOLDERS ---
        mode = row.get("mode")

        if mode == "FOL":
            row.setdefault("room1", "Online")
            row.setdefault("room2", "Online")
        elif mode == "HYB":
            row.setdefault("room1", "Classroom")
            row.setdefault("room2", "Online")
        else:
            row.setdefault("room1", "Classroom")
            # room2 can stay as-is / optional

        # --- ROOM TYPE (derived) ---
        room1 = (row.get("room1") or "").strip()
        room2 = (row.get("room2") or "").strip()

        if room1 == "TBA" or room2 == "TBA":
            row["room_type"] = None
        elif (not room1 and not room2) or room1 == "Online" or room2 == "Online":
            row["room_type"] = "Online"
        else:
            row["room_type"] = "Classroom"

# ------------------ Algorithm lives HERE ------------------
# Make sure the name matches what the route calls,
# and it’s defined ABOVE the route.
async def build_load_recommendations(
    db,
    *,
    term_id: str,
    department_id: str,
    only_section_ids: List[str] | None = None,
    respect_locks: bool = True,
) -> Dict[str, Any]:
    """
    Read sections/faculty/etc. from DB and fill faculty/day/time/room.
    Return {"rows": [...]} matching your frontend Row type.
    """
    # 1) fetch sections for term/department (optionally filter by only_section_ids)
    # 2) fetch faculty_profiles, faculty_preferences, rooms, constraints
    # 3) compute assignments + detect conflicts
    # 4) shape rows as the UI expects
    rows: List[Dict[str, Any]] = [
        # example shape; replace with real computed rows
        # {
        #   "id": "ASG0001", "course": "CCPROG1", "title": "...", "units": 3,
        #   "section": "S11", "faculty": "Last, First",
        #   "day1":"M","begin1":"07:30","end1":"09:00","room1":"CL-101",
        #   "day2":"H","begin2":"07:30","end2":"09:00","room2":"CL-101",
        #   "capacity": 40, "status":"Pending", "conflictNote":"", "editable": True
        # }
    ]
    return {"rows": rows}

# ----------------------------------------------------------
def _term_label(t: dict) -> str:
    """Human-friendly term label.

    Prefer showing Term Number + Academic Year (AY) instead of internal term_id.
    Format: 'Term {term_number} · AY {acad_year_start}-{acad_year_start+1}'.
    """
    if not t:
        return ""
    n = t.get('term_number')
    ay = t.get('acad_year_start')
    try:
        ay_int = int(ay) if ay is not None else None
    except Exception:
        ay_int = None
    aye = (ay_int + 1) if ay_int is not None else None
    if n and ay_int is not None and aye is not None:
        return f"Term {n} · AY {ay_int}-{aye}"
    return str(t.get('term_id') or '')

def _aa_reason_label(reason: str) -> str:
    reason = str(reason or "").strip()

    if reason == "recent_history":
        return "Recently Taught"

    if reason in {
        "older_history",
        "ft_extra_history",
        "pt_history",
        "history_rescue",
    }:
        return "Taught in the Past"

    if reason in {
        "kac_fallback",
        "ft_extra_kac",
        "pt_kac",
        "rescue_overload",
    }:
        return "KAC Match"

    return "KAC Match"

def _aa_reason_sentence(reason: str, term_label: str = "") -> str:
    label = _aa_reason_label(reason)

    if label == "Recently Taught":
        if term_label:
            return f"This professor was assigned because they taught this course recently ({term_label})."
        return "This professor was assigned because they taught this course recently."

    if label == "Taught in the Past":
        if term_label:
            return f"This professor was assigned because they previously taught this course ({term_label})."
        return "This professor was assigned because they previously taught this course."

    return "This professor was assigned because their area of expertise matches the course requirements."

def _row_is_locked(r: dict) -> bool:
    """
    Treat a row as 'locked' if it should not be altered by auto-assign.

    Locked when (protected rows):
      - Row was explicitly finalized by OM (row['finalized'] truthy), OR
      - Row is marked locked/terminal in any upstream workflow
        (row['locked'], synced rows, approved/forwarded terminal states), OR
      - Row already has a concrete manual load:
          * faculty_id is set
          * and at least one full day/begin/end slot is filled.

    These rows will be preserved when running auto-assign.
    """
    # Explicit locks/finalized/terminal states
    if bool(r.get("finalized")):
        return True

    if bool(r.get("locked")):
        return True

    # Rows synced from Faculty Service (or another system) should never be altered.
    if bool(r.get("synced_from_faculty_service")):
        return True

    # Rows that were forwarded and reached an "approved" terminal state should be protected.
    try:
        if bool(r.get("forwarded_to_faculty")):
            st = str(r.get("status") or "").strip().lower()
            if st in ("approved", "accepted", "forwarded", "submitted"):
                return True
    except Exception:
        # Never block auto-assign due to a bad status shape.
        pass

    fid = (r.get("faculty_id") or "").strip()
    if not fid:
        return False

    has_slot1 = bool(r.get("day1") and r.get("begin1") and r.get("end1"))
    has_slot2 = bool(r.get("day2") and r.get("begin2") and r.get("end2"))

    return has_slot1 or has_slot2

router = APIRouter(prefix="/om", tags=["om"])

@router.post("/loadassignment")
async def loadassignment_handler(
    userId: str = Query(..., min_length=3),
    action: str = Query("fetch", description="fetch | options | profile | submit"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    if action == "fetch":
        active = await _active_term()
        if not active:
            raise HTTPException(409, "No upcoming term found (is_current anchor missing?)")
        data = await _fetch_rows(userId, term_id=active["term_id"], db=db)
        return data

    if action == "options":
        # Keep minimal for now; extend dropdowns later if UI needs them
        depts = [d async for d in db[COL_DEPTS].find(
            {}, {"_id": 0, "department_id": 1, "department_name": 1, "dept_name": 1}
        )]
        return {
            "ok": True,
            "departments": [ (d.get("department_name") or d.get("dept_name") or "").strip() for d in depts if d ],
            "statuses": ["Confirmed", "Pending", "Unassigned", "Conflict"],
        }

    # APO-set schedule + faculty encoding deadline windows.
    # Frontend compatibility: some UI calls /om/loadassignment?action=deadline_window.
    # Return BOTH campus deadlines (Manila + Laguna) so OM can see them at once.
    if action == "deadline_window":
        active = await _active_term()
        if not active or not active.get("term_id"):
            raise HTTPException(status_code=409, detail="No active/upcoming term found")

        term_id = str(active.get("term_id") or "").strip()

        # Prefer known campuses; also include any additional campus_id values found in storage.
        known = ["CMPS0001", "CMPS0002"]
        windows: list[dict] = []

        docs = await db[COL_OM_SUBMIT_WINDOWS].find(
            {"term_id": term_id},
            {"_id": 0, "campus_id": 1, "openISO": 1, "deadlineISO": 1},
        ).to_list(None)

        found_norm: set[str] = set()
        for d in docs or []:
            raw = str((d or {}).get("campus_id") or "").strip()
            if not raw:
                continue
            found_norm.add((await _normalize_campus_id(raw, db)) or raw)

        campus_ids = list(dict.fromkeys([*known, *sorted(found_norm)]))

        for cid in campus_ids:
            w = await _get_om_submit_window(term_id, cid, db)
            if not w or not (w.get("deadlineISO") or "").strip():
                continue

            campus_name = cid
            try:
                camp = await db["campuses"].find_one(
                    {"campus_id": cid},
                    {"_id": 0, "campus_name": 1},
                ) or {}
                campus_name = (camp.get("campus_name") or cid).strip() or cid
            except Exception:
                campus_name = cid

            has_apo = await _has_apo_submission(term_id, cid, db)
            windows.append(
                {
                    "campus_id": cid,
                    "campus_name": campus_name,
                    "openISO": w.get("openISO") or "",
                    "deadlineISO": w.get("deadlineISO") or "",
                    "deadline_passed": _deadline_passed(w),
                    "has_apo_submission": bool(has_apo),
                }
            )

        return {
            "ok": True,
            "term": _term_label(active),
            "term_id": term_id,
            "windows": windows,
        }

    # --- inside loadassignment_handler(), replace the current "profile" branch ---
    if action == "profile":
        # --- existing lookups (users/staff) can stay as-is ---
        staff = await db["staff_profiles"].find_one(
            {"user_id": userId},
            {"_id": 0, "staff_id": 1, "position_title": 1}
        ) or {}

        u = await db["users"].find_one(
            {"user_id": userId},
            {"_id": 0, "first_name": 1, "last_name": 1}
        ) or {}
        full_name = " ".join([p for p in [(u.get("first_name") or "").strip(),
                                        (u.get("last_name") or "").strip()] if p])

        # --- Resolve department via role_assignments -> departments (robust parsing) ---
        # NOTE: Some datasets don't have is_active/updated_at/created_at. We therefore:
        #  - do NOT filter by is_active
        #  - sort by whichever recency keys exist
        #  - parse scope defensively (case-insensitive type, id keys may vary)
        ra_docs = await db["role_assignments"].find(
            {"user_id": userId},
            {
                "_id": 0,
                "role_id": 1,
                "scope": 1,
                "updated_at": 1,
                "created_at": 1,
                "role_assignment_id": 1,
                "until_term_id": 1,
            },
        ).sort(
            [("updated_at", -1), ("created_at", -1), ("role_assignment_id", -1)]
        ).to_list(10)

        def _norm_scope_list(scope_val: Any) -> list[dict]:
            if not scope_val:
                return []
            if isinstance(scope_val, dict):
                return [scope_val]
            if isinstance(scope_val, list):
                return [s for s in scope_val if isinstance(s, dict)]
            return []

        dept_id: Optional[str] = None
        role_id: Optional[str] = None

        for row in ra_docs or []:
            if not role_id:
                role_id = row.get("role_id")

            scopes = _norm_scope_list(row.get("scope"))
            for s in scopes:
                stype = str(s.get("type") or "").strip().lower()
                if stype != "department":
                    continue
                # id key can vary across seeders
                cand = s.get("id") or s.get("department_id") or s.get("dept_id")
                if cand:
                    dept_id = str(cand).strip()
                    break
            if dept_id:
                break

        dept_name = ""
        if dept_id:
            # departments collection key can vary; try common variants.
            d = await db["departments"].find_one(
                {
                    "$or": [
                        {"department_id": dept_id},
                        {"dept_id": dept_id},
                        {"id": dept_id},
                    ]
                },
                {"_id": 0, "dept_name": 1, "department_name": 1, "name": 1, "dept_code": 1},
            ) or {}
            dept_name = (
                d.get("dept_name")
                or d.get("department_name")
                or d.get("name")
                or ""
            ).strip()

        # Optional: normalize role display (example for ROLE0006)
        position_title = staff.get("position_title") or ""
        if not position_title and role_id == "ROLE0006":
            position_title = "Office Manager"

        return {
            "ok": True,
            "full_name": full_name,
            "position_title": position_title,
            "dept_name": dept_name,
            # keep any other fields you already return
        }

    if action == "save_remarks":
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="Invalid payload; expected JSON object")

        schedule_id = str(payload.get("schedule_id") or "").strip()
        remarks = str(payload.get("remarks") or "")

        if not schedule_id:
            raise HTTPException(status_code=400, detail="schedule_id is required")

        # Resolve section via section_schedules to avoid guessing/wrong section identifiers.
        sched = await db[COL_SCHED].find_one(
            {"schedule_id": schedule_id},
            {"_id": 0, "section_id": 1, "term_id": 1},
        )
        if not sched or not (sched.get("section_id") or "").strip():
            raise HTTPException(status_code=404, detail="Schedule not found")

        section_id = str(sched.get("section_id") or "").strip()

        # Enforce campus-specific APO deadline lock for remarks (edit field).
        # Manila and Laguna deadlines can differ; only lock the affected campus.
        try:
            term_id = str(sched.get("term_id") or "").strip()
            if term_id:
                campus_id = await _section_campus_id_for_row(section_id, "", term_id, db)
                if campus_id:
                    w = await _get_om_submit_window(term_id, campus_id, db)
                    if _deadline_passed(w):
                        raise HTTPException(
                            status_code=403,
                            detail="Editing is locked because the APO-set deadline for this campus has passed.",
                        )
        except HTTPException:
            raise
        except Exception:
            # Best-effort: do not block if window cannot be resolved.
            pass

        res = await db["sections"].update_one(
            {"section_id": section_id},
            {"$set": {"remarks": remarks}},
        )
        if res.matched_count == 0:
            raise HTTPException(status_code=404, detail="Section not found")

        return {"ok": True, "section_id": section_id, "remarks": remarks}

    if action == "save":
        # same validation as approve
        if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list):
            raise HTTPException(
                status_code=400,
                detail="Invalid payload; expected { rows: [...] }",
            )

        active = await _active_term()
        if not active:
            raise HTTPException(
                409, "No upcoming term found (is_current anchor missing?)"
            )

        rows = payload["rows"]

        # Campus-specific APO deadlines:
        # If a campus' deadline has passed, OM must NOT be able to modify rows of that campus.
        # This should not block saving other campus rows (e.g., Manila locked but Laguna editable).
        try:
            campus_ids_in_rows: set[str] = set()
            for rr in rows:
                if not isinstance(rr, dict):
                    continue
                cid = str(rr.get("campus_id") or "").strip()
                if not cid:
                    # best-effort: infer from section_code
                    cid = _section_to_campus_id(str(rr.get("section") or "").strip())
                if cid:
                    campus_ids_in_rows.add(cid)

            deadline_passed_by_campus: dict[str, bool] = {}
            for cid in sorted(campus_ids_in_rows):
                w = await _get_om_submit_window(active["term_id"], cid, db)
                deadline_passed_by_campus[cid] = _deadline_passed(w)

            if deadline_passed_by_campus:
                kept: list[dict] = []
                skipped = 0
                for rr in rows:
                    if not isinstance(rr, dict):
                        continue
                    cid = str(rr.get("campus_id") or "").strip()
                    if not cid:
                        cid = _section_to_campus_id(str(rr.get("section") or "").strip())
                    if cid and deadline_passed_by_campus.get(cid):
                        skipped += 1
                        continue
                    kept.append(rr)
                rows = kept
        except Exception:
            # Best-effort only: never break SAVE if deadline resolution fails.
            pass

        # Just persist assignments/schedules – no faculty_loads header yet
        await _persist_rows_no_auto(active["term_id"], rows, db)

        return {
            "ok": True,
            "saved": len(rows),
            "term": _term_label(active),
        }

    if action == "submit":
        # Validate
        if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list):
            raise HTTPException(status_code=400, detail="Invalid payload; expected { rows: [...] }")
        submitted_rows = payload["rows"]

        # Block submit after APO-set deadline (schedule + faculty encoding)
        try:
            active = await _active_term()
            if active and active.get("term_id"):
                campus_id = (await _infer_campus_id_for_user(userId, db)) or ""
                if not campus_id:
                    campus_id = (await _infer_campus_id_from_rows(submitted_rows, db)) or ""
                if campus_id:
                    w = await _get_om_submit_window(active["term_id"], campus_id, db)
                    if _deadline_passed(w):
                        raise HTTPException(
                            status_code=403,
                            detail="Submission is locked because the APO-set deadline has passed.",
                        )
        except HTTPException:
            raise
        except Exception:
            # Best-effort: do not block if window cannot be resolved.
            pass

        return {"ok": True, "rows": submitted_rows}

    if action == "approve":
        if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list):
            raise HTTPException(
                status_code=400,
                detail="Invalid payload; expected { rows: [...] }",
            )

        active = await _active_term()
        if not active:
            raise HTTPException(
                409, "No upcoming term found (is_current anchor missing?)"
            )

        rows = payload["rows"]

        # Block approve/forward after APO-set deadline
        try:
            campus_id = (await _infer_campus_id_for_user(userId, db)) or ""
            if not campus_id:
                campus_id = (await _infer_campus_id_from_rows(rows, db)) or ""
            if campus_id:
                w = await _get_om_submit_window(active.get("term_id"), campus_id, db)
                if _deadline_passed(w):
                    raise HTTPException(
                        status_code=403,
                        detail="Approval is locked because the APO-set deadline has passed.",
                    )
        except HTTPException:
            raise
        except Exception:
            pass

        # Determine whether this is the first forward (new header) or a re-forward/update.
        # Keep your existing header behavior, but resolve recipients robustly for notifications.
        dept_id_header = "DEPT0001"  # existing behavior
        dept_id_notif = await _infer_department_id_from_rows(rows, db) or dept_id_header

        existing_header = await db[COL_FACULTY_LOADS].find_one(
            {"term_id": active.get("term_id"), "department_id": dept_id_header},
            {"_id": 1, "load_id": 1, "forwarded_to_chair": 1, "forwarded_to_chair_at": 1},
        )

        # IMPORTANT:
        # A header can exist even before OM actually forwards to the chair.
        # So "updated vs submitted" should be based on forwarded_to_chair, not existence alone.
        was_forwarded_before = bool((existing_header or {}).get("forwarded_to_chair"))

        # 1) persist the final assignments/schedules
        await _approve_and_persist(active["term_id"], rows, db)

        # 2) create/update faculty_loads header for this term (also marks forwarded_to_chair=True)
        # Snapshot the exact sections currently visible in the OM Load Assignment table.
        fwd_section_ids = sorted({str(r.get('section_id') or r.get('id') or '').strip() for r in rows if str(r.get('section_id') or r.get('id') or '').strip()})

        await _upsert_faculty_load_header(
            active,
            db,
            department_id=dept_id_header,  # existing behavior
            user_id=userId,            # query param from the route
            forwarded_section_ids=fwd_section_ids,
        )

        # fetch header again to get reco_id after upsert
        header_after = await db[COL_FACULTY_LOADS].find_one(
            {"term_id": active.get("term_id"), "department_id": dept_id_header},
            {"_id": 0, "load_id": 1},
        ) or {}
        reco_id = header_after.get("load_id") or (existing_header or {}).get("load_id")

        kind = "om_load_updated" if was_forwarded_before else "om_load_forwarded"

        # 3) notify the department chair(s)
        try:
            recipients = await _chair_user_ids_for_department_id(dept_id_notif, db)
            dept_name = await _dept_name_by_id(dept_id_notif, db)

            is_update = was_forwarded_before
            title = "Load Recommendation Revised" if is_update else "Load Recommendation Submitted"
            details = (
                f"OM {'revised' if is_update else 'submitted'} the load recommendation "
                f"for {dept_name or dept_id_notif} ({_term_label(active)})."
            )
            meta = {
                "route": "/chair/plantilla",
                "kind": kind,
                "reco_id": reco_id,                 # aligns with notify-chair endpoint spec
                "term_id": active.get("term_id"),
                "department_id": dept_id_notif,
                # keep old key for backward compatibility if any UI depends on it
                "load_id": reco_id,
            }

            for uid in recipients:
                # Backfill missing users.gmail (some Chair accounts only have users.email).
                await _ensure_user_gmail_address(uid, db)
                # Send BOTH in-app + Gmail notification (best-effort) using the OM's connected Gmail.
                await create_notification(
                    user_id=uid,
                    title=title,
                    details=details,
                    meta=meta,
                    send_email=True,
                    email_from_user_id=userId,
                )
        except Exception:
            # Never break approval due to notification failure
            pass

        return {
            "ok": True,
            "approved": len(rows),
            "term": _term_label(active),
            "kind": kind,
            "reco_id": reco_id,
        }

    if action == "import_shs":
        """Import SHS CSV into sections/section_schedules/faculty_assignments and expose rows in OM table.

        Payload shape:
          { csv: "..." }
        The CSV must include columns:
          Course Code & Title, Units, Section,
          Day 1, Begin 1, End 1, Room 1,
          Day 2, Begin 2, End 2, Room 2,
          Capacity, Mode
        """
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="Invalid payload; expected { csv: \"...\" }")

        csv_text = payload.get("csv") or payload.get("content") or payload.get("text")
        if not isinstance(csv_text, str) or not csv_text.strip():
            raise HTTPException(status_code=400, detail="Missing csv content.")

        active = await _active_term()
        if not active:
            raise HTTPException(409, "No upcoming term found (is_current anchor missing?)")

        term_id = active.get("term_id")
        ts = datetime.utcnow()

        # Best-effort campus_id fallback from staff profile (optional).
        # Note: If the CSV includes a "Campus" column, per-row Campus will override this fallback.
        staff = await db[COL_STAFF].find_one({"user_id": userId}, {"_id": 0, "campus_id": 1}) or {}
        campus_id_fallback = (staff.get("campus_id") or "").strip()

        # Parse CSV
        reader = csv.DictReader(io.StringIO(csv_text))
        if not reader.fieldnames:
            raise HTTPException(status_code=400, detail="CSV has no headers.")

        # Build a flexible header map
        hmap = { _norm_header(h): h for h in (reader.fieldnames or []) }

        def col(*names: str) -> str | None:
            for n in names:
                k = _norm_header(n)
                if k in hmap:
                    return hmap[k]
            return None

        c_course = col("Course Code & Title", "Course", "Course Code", "Course Code and Title")
        c_units = col("Units", "Unit")
        c_section = col("Section")
        c_day1 = col("Day 1", "Day1")
        c_begin1 = col("Begin 1", "Start 1", "Begin1")
        c_end1 = col("End 1", "End1")
        c_room1 = col("Room 1", "Room1")
        c_day2 = col("Day 2", "Day2")
        c_begin2 = col("Begin 2", "Start 2", "Begin2")
        c_end2 = col("End 2", "End2")
        c_room2 = col("Room 2", "Room2")
        c_cap = col("Capacity", "Cap")
        c_mode = col("Mode")

        # Optional: per-row campus (Manila/Laguna). Saved to sections_submitted.campus_id.
        c_campus = col("Campus")

        # Optional: per-row campus value ("Manila" or "Laguna").
        c_campus = col("Campus")

        # Optional: allow SHS import files to include per-section remarks
        # (requested to be saved in sections_submitted.remarks and shown in the remarks column)
        c_remarks = col("Remarks", "Remark", "Notes", "Note")

        missing = [
            n for n, c in [
                ("Course Code & Title", c_course),
                ("Units", c_units),
                ("Section", c_section),
                ("Day 1", c_day1),
                ("Begin 1", c_begin1),
                ("End 1", c_end1),
                ("Room 1", c_room1),
                ("Day 2", c_day2),
                ("Begin 2", c_begin2),
                ("End 2", c_end2),
                ("Room 2", c_room2),
                ("Capacity", c_cap),
                ("Mode", c_mode),
            ] if not c
        ]
        if missing:
            raise HTTPException(status_code=422, detail=f"Missing required columns: {', '.join(missing)}")

        imported = 0
        created_courses = 0
        created_sections = 0

        async def ensure_course(course_code: str, title: str, units_val: Any) -> str:
            nonlocal created_courses
            cc = (course_code or "").strip()
            if not cc:
                raise HTTPException(status_code=422, detail="Course code is required.")

            q = {
                "$or": [
                    {"course_code": cc},
                    {"course_code": {"$in": [cc]}},
                    {"course_code": {"$elemMatch": {"$regex": rf"^{re.escape(cc)}$", "$options": "i"}}},
                ]
            }
            doc = await db[COL_COURSES].find_one(q, {"_id": 0, "course_id": 1})
            if doc and doc.get("course_id"):
                return str(doc["course_id"]).strip()

            cid = await _next_seq_id(db, COL_COURSES, "course_id", "CRS", 4)
            try:
                units = float(str(units_val or "").strip()) if str(units_val or "").strip() else 0.0
            except Exception:
                units = 0.0

            await db[COL_COURSES].insert_one({
                "course_id": cid,
                "course_code": cc,
                "course_title": (title or "").strip(),
                "units": units,
                "type_of_course": "SHS",
                "type": "SHS",
                "created_at": ts,
                "updated_at": ts,
            })
            created_courses += 1
            return cid

        for raw in reader:
            if not isinstance(raw, dict):
                continue

            # Parse course code + title
            cct = str(raw.get(c_course) or "").strip()
            if not cct:
                continue
            # allow formats: "CODE - Title" | "CODE: Title" | "CODE Title"
            course_code = ""
            course_title = ""
            if " - " in cct:
                course_code, course_title = cct.split(" - ", 1)
            elif ":" in cct:
                course_code, course_title = cct.split(":", 1)
            else:
                parts = cct.split()
                course_code = parts[0] if parts else cct
                course_title = " ".join(parts[1:])

            units_val = raw.get(c_units)
            section_code = str(raw.get(c_section) or "").strip()
            if not section_code:
                continue

            # capacity
            try:
                cap = int(float(str(raw.get(c_cap) or "").strip()))
            except Exception:
                cap = 0

            mode = str(raw.get(c_mode) or "").strip().upper()

            # Optional per-row remarks.
            remarks_val = ""
            if c_remarks:
                remarks_val = str(raw.get(c_remarks) or "").strip()

            # Resolve campus_id.
            campus_id = campus_id_fallback
            if c_campus:
                campus_raw = str(raw.get(c_campus) or "").strip()
                if campus_raw:
                    try:
                        campus_id = _campus_name_to_id(campus_raw)
                    except ValueError:
                        raise HTTPException(
                            status_code=422,
                            detail=f"Invalid Campus value '{campus_raw}' for section '{section_code}'. Use Manila or Laguna.",
                        )

            course_id = await ensure_course(course_code, course_title, units_val)

            # Create a new section_id. If the same section_code+course exists for term, upsert instead.
            existing_sec = await db[COL_SECTIONS].find_one(
                {"term_id": term_id, "course_id": course_id, "section_code": section_code},
                {"_id": 0, "section_id": 1},
            )
            if existing_sec and existing_sec.get("section_id"):
                section_id = str(existing_sec["section_id"]).strip()
            else:
                section_id = await _next_seq_id(db, COL_SECTIONS, "section_id", "SEC", 4)
                created_sections += 1

            sec_doc = {
                "section_id": section_id,
                "term_id": term_id,
                "campus_id": campus_id,
                "course_id": course_id,
                "section_code": section_code,
                "enrollment_cap": cap,
                "mode": mode,
                "status": "active",
                "submitted_for_scheduling": True,
                "submitted_at": ts,
                "submitted_by": userId,
                "updated_at": ts,
            }

            # Persist SHS import remarks.
            # - Requested storage: sections_submitted.remarks
            # - Also store it in sections.remarks so existing remarks-loading logic continues to work.
            # Only set if provided to avoid wiping existing remarks.
            if remarks_val:
                sec_doc["remarks"] = remarks_val

            await db[COL_SECTIONS].update_one(
                {"section_id": section_id},
                {"$set": sec_doc, "$setOnInsert": {"created_at": ts}},
                upsert=True,
            )

            # Mirror into submitted snapshot so it shows immediately on OM list
            snap_doc = dict(sec_doc)
            snap_doc["snapshot_at"] = ts
            await db[COL_SECTIONS_SUBMITTED].update_one(
                {"term_id": term_id, "campus_id": campus_id, "section_id": section_id},
                {"$set": snap_doc, "$setOnInsert": {"created_at": ts}},
                upsert=True,
            )

            # Schedules (two slots)
            for slot, (cd, cb, ce, cr) in enumerate(
                [
                    (raw.get(c_day1), raw.get(c_begin1), raw.get(c_end1), raw.get(c_room1)),
                    (raw.get(c_day2), raw.get(c_begin2), raw.get(c_end2), raw.get(c_room2)),
                ],
                start=1,
            ):
                day = str(cd or "").strip()
                begin = _parse_time_str(cb)
                end = _parse_time_str(ce)
                room_val = str(cr or "").strip()
                room_id = await _resolve_room_id(db, room_val) if room_val else None

                sched_id = _sch_id_from_sec(section_id, slot)
                await db[COL_SCHED].update_one(
                    {"section_id": section_id, "schedule_id": sched_id},
                    {
                        "$set": {
                            "schedule_id": sched_id,
                            "section_id": section_id,
                            "day": day or None,
                            "start_time": begin or None,
                            "end_time": end or None,
                            "room_id": room_id,
                            "updated_at": ts,
                        },
                        "$setOnInsert": {"created_at": ts},
                    },
                    upsert=True,
                )

            # Placeholder faculty assignment if none exists
            existing_asg = await db[COL_ASSIGN].find_one(
                {"section_id": section_id, "is_archived": {"$ne": True}},
                {"_id": 0, "assignment_id": 1},
            )
            if not existing_asg:
                await db[COL_ASSIGN].insert_one({
                    "assignment_id": _asg_id_from_sec(section_id),
                    "section_id": section_id,
                    "faculty_id": "",
                    "user_id": "",
                    "is_archived": False,
                    "created_at": ts,
                    "updated_at": ts,
                })

            try:
                details = (
                    f"A new SHS section was imported and may need room review.\n\n"
                    f"Course: {course_code} — {course_title.strip()}\n"
                    f"Section: {section_code}\n"
                    f"Mode: {mode}\n"
                    f"Capacity: {cap}"
                ).strip()

                meta = {
                    "route": "/apo/courseofferings",
                    "kind": "shs_import_added_section",
                    "term_id": term_id,
                    "section_id": section_id,
                    "campus_id": campus_id,
                    "course_id": course_id,
                    "course_code": course_code,
                    "section_code": section_code,
                }

                apo_uids: list[str] = []
                try:
                    if campus_id:
                        apo_uids = await _apo_user_ids_for_campus(campus_id, db)
                except Exception:
                    apo_uids = []

                # Fallback: if campus routing fails, notify all APO users (same as new-line)
                if not apo_uids:
                    try:
                        apo_uids = await _all_apo_user_ids(db)
                    except Exception:
                        apo_uids = []

                # De-duplicate and never notify the actor
                apo_uids = sorted({uid for uid in (apo_uids or []) if uid and uid != userId})

                for uid in apo_uids:
                    try:
                        try:
                            await _ensure_user_gmail_address(uid, db)
                        except Exception:
                            pass

                        await create_notification(
                            user_id=uid,
                            title="New SHS section imported",
                            details=details,
                            meta=meta,
                            send_email=True,          # set False if you only want in-app
                            email_from_user_id=userId,
                        )
                    except Exception:
                        continue
            except Exception:
                # Never fail import due to notification issues
                pass

            imported += 1

        return {
            "ok": True,
            "imported": imported,
            "created_courses": created_courses,
            "created_sections": created_sections,
            "term": _term_label(active),
            "term_id": term_id,
        }



    raise HTTPException(status_code=400, detail="Invalid action parameter.")

@router.post("/loadassignment/notify-chair")
async def om_notify_chair_load_forwarded(
    userId: str = Query(..., min_length=3),
    payload: Dict[str, Any] = Body(...),
):
    active = await _active_term()
    if not active:
        raise HTTPException(409, "No upcoming term found (is_current anchor missing?)")

    # Best-effort dept resolution
    dept_id_header = "DEPT0001"  # keep your existing header behavior
    dept_id_notif = (
        (payload.get("department_id") or payload.get("dept_id") or "").strip()
        or await _infer_department_id_from_rows(payload.get("rows") or [], db)
        or dept_id_header
    )

    # reco_id (prefer payload; else pull from faculty_loads header)
    header = await db[COL_FACULTY_LOADS].find_one(
        {"term_id": active.get("term_id"), "department_id": dept_id_header},
        {"_id": 0, "load_id": 1},
    ) or {}
    reco_id = (payload.get("reco_id") or payload.get("recoId") or header.get("load_id"))

    # kind (prefer payload; else infer: if any prior notif exists for this reco_id => updated)
    kind = (payload.get("kind") or "").strip()
    if kind not in ("om_load_forwarded", "om_load_updated"):
        inferred = "om_load_forwarded"
        if reco_id:
            prior = await db["notifications"].find_one(
                {"meta.reco_id": reco_id, "meta.kind": "om_load_forwarded"},
                {"_id": 0, "notif_id": 1},
            )
            if prior:
                inferred = "om_load_updated"
        kind = inferred

    recipients = await _chair_user_ids_for_department_id(dept_id_notif, db)
    dept_name = await _dept_name_by_id(dept_id_notif, db)

    title = "Load Recommendation Revised" if kind == "om_load_updated" else "Load Recommendation Submitted"
    details = (
        f"OM {'revised' if kind == 'om_load_updated' else 'submitted'} the load recommendation "
        f"for {dept_name or dept_id_notif} ({_term_label(active)})."
    )
    meta = {
        "route": "/chair/plantilla",
        "kind": kind,
        "reco_id": reco_id,                 # REQUIRED by your spec
        "term_id": active.get("term_id"),
        "department_id": dept_id_notif,
    }

    created = 0
    for uid in recipients:
        # Backfill missing users.gmail (some Chair accounts only have users.email).
        await _ensure_user_gmail_address(uid, db)
        # Send BOTH in-app + Gmail notification (best-effort) using the OM's connected Gmail.
        await create_notification(
            user_id=uid,
            title=title,
            details=details,
            meta=meta,
            send_email=True,
            email_from_user_id=userId,
        )
        created += 1

    return {
        "ok": True,
        "created": created,
        "recipients": recipients,
        "kind": kind,
        "reco_id": reco_id,
    }

@router.get("/load-assignment/faculty-all")
async def om_get_all_faculty(db = Depends(get_db)):
    pipeline = [
        {
            # Only include faculty under the required department.
            "$match": {
                "is_archived": {"$ne": True},
                "department_id": "DEPT0001",
            }
        },
        # Exclude faculty who are currently on an approved leave.
        # NOTE: Per requirement, any APPROVED leave record is sufficient to exclude.
        {
            "$lookup": {
                "from": COL_LEAVES,
                "let": {"fid": "$faculty_id"},
                "pipeline": [
                    {
                        "$match": {
                            "$expr": {
                                "$and": [
                                    {"$eq": ["$faculty_id", "$$fid"]},
                                    {"$eq": ["$approval_status", "APPROVED"]},
                                ]
                            }
                        }
                    },
                    {"$project": {"_id": 0, "faculty_id": 1}},
                ],
                "as": "approved_leaves",
            }
        },
        {
            "$match": {
                "approved_leaves.0": {"$exists": False}
            }
        },
        {
            "$lookup": {
                "from": "users",
                "localField": "user_id",
                "foreignField": "user_id",
                "as": "user"
            }
        },
        {
            "$unwind": "$user"
        },
        {
            "$unset": "approved_leaves"
        },
        {
            "$set": {
                "faculty_name_display": {
                    "$concat": ["$user.last_name", ", ", "$user.first_name"]
                }
            }
        },
        {
            "$project": {
                "_id": 0,
                "faculty_id": 1,
                "faculty_name_display": 1
            }
        },
        {
            "$sort": {
                "faculty_name_display": 1
            }
        }
    ]
    docs = await db[COL_FACULTY].aggregate(pipeline).to_list(None)
    return {"ok": True, "faculty": docs}

async def _current_and_planning_term_ids(db) -> Tuple[Optional[str], Optional[str]]:
    """
    Mirrors /load-assignment/planning-term:
      - current_term_id: terms.is_current == True
      - planning_term_id: _active_term().term_id (upcoming/planning term in OM)
    """
    cur = await db[COL_TERMS].find_one(
        {"is_current": True},
        {"_id": 0, "term_id": 1},
    )
    current_term_id = (cur or {}).get("term_id")

    planning = await _active_term()
    planning_term_id = (planning or {}).get("term_id")

    current_term_id = str(current_term_id).strip() if current_term_id else None
    planning_term_id = str(planning_term_id).strip() if planning_term_id else None
    return current_term_id, planning_term_id

@router.get("/load-assignment/faculty-with-deloadings")
async def om_faculty_with_deloadings(db=Depends(get_db)):
    active = await _active_term()
    term_id = (active or {}).get("term_id")
    if not term_id:
        return {"ok": True, "term_id": None, "faculty": []}

    fac_ids = await db["deloadings"].distinct("faculty_id", {"term_id": term_id})
    fac_ids = [fid for fid in (fac_ids or []) if fid]
    if not fac_ids:
        return {"ok": True, "term_id": term_id, "faculty": []}

    pipeline = [
        {"$match": {"faculty_id": {"$in": fac_ids}, "is_archived": {"$ne": True}}},
        {"$lookup": {"from": "users", "localField": "user_id", "foreignField": "user_id", "as": "user"}},
        {"$unwind": "$user"},
        {"$set": {"faculty_name_display": {"$concat": ["$user.last_name", ", ", "$user.first_name"]}}},
        {"$project": {"_id": 0, "faculty_id": 1, "faculty_name_display": 1}},
        {"$sort": {"faculty_name_display": 1}},
    ]
    docs = await db[COL_FACULTY].aggregate(pipeline).to_list(None)
    return {"ok": True, "term_id": term_id, "faculty": docs}

@router.get("/load-assignment/faculty-deloadings")
async def om_faculty_deloadings(
    faculty_id: str = Query(..., description="Faculty ID"),
    db=Depends(get_db),
):
    active = await _active_term()
    term_id = (active or {}).get("term_id")
    if not term_id:
        return {"ok": True, "term_id": None, "faculty_id": faculty_id, "rfc_id": None, "rows": []}

    rows: List[Dict[str, Any]] = []
    deloadings = await db["deloadings"].find({"term_id": term_id, "faculty_id": faculty_id}).to_list(None)

    for d in deloadings or []:
        dt = await db["deloading_types"].find_one(
            {"$or": [{"type_id": d.get("type_id")}, {"deloadingtype_id": d.get("type_id")}]}
        )
        rows.append(
            {
                "deloading_type": (dt or {}).get("type"),
                "units_deloaded": d.get("units_deloaded"),
                "notes": (d.get("notes") or d.get("deloading_notes") or "").strip() or None,
                "term_id": term_id,
                "updated_at": d.get("updated_at"),
            }
        )

    rows.sort(key=lambda x: -(x["updated_at"].timestamp() if x.get("updated_at") else 0))
    return {"ok": True, "term_id": term_id, "faculty_id": faculty_id, "rfc_id": None, "rows": rows}

@router.get("/load-assignment/terms")
async def om_load_assignment_terms(db=Depends(get_db)):
    """List terms for archived load viewing.

    Returns terms sorted from most recent to oldest, along with the OM "active" term id
    (the same term used by the Load Assignment screen by default).
    """
    active = await _active_term()
    active_term_id = (active or {}).get("term_id")

    docs = await db[COL_TERMS].find(
        {},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1, "is_current": 1},
    ).sort([("acad_year_start", -1), ("term_number", -1)]).to_list(None)

    terms = []
    for t in docs or []:
        tid = (t.get("term_id") or "").strip()
        if not tid:
            continue

        # Skip academic terms that have no archived load data.
        # Archived loads primarily come from `sections_submitted` (submitted_for_scheduling=True).
        # However, legacy terms may not have the `submitted_for_scheduling` flag at all
        # (field missing / null). Those terms should still be selectable in Archived Loads.
        # We therefore treat (True OR missing OR null) as "archived-load-capable".
        # We also check `sections` as a legacy fallback for deployments migrated before
        # `sections_submitted` existed.
        try:
            submitted_flag_or_legacy = {
                "$or": [
                    {"submitted_for_scheduling": True},
                    {"submitted_for_scheduling": {"$exists": False}},
                    {"submitted_for_scheduling": None},
                ]
            }

            has_archived = await db[COL_SECTIONS_SUBMITTED].find_one(
                {"term_id": tid, **submitted_flag_or_legacy},
                {"_id": 1},
            )
            if not has_archived:
                has_archived = await db[COL_SECTIONS].find_one(
                    {"term_id": tid, **submitted_flag_or_legacy},
                    {"_id": 1},
                )
            if not has_archived:
                continue
        except Exception:
            # Best-effort filter only; if the check fails, keep existing behavior (show term).
            pass

        terms.append(
            {
                "term_id": tid,
                "label": _term_label(t),
                "is_current": bool(t.get("is_current")),
                "is_active": bool(active_term_id and tid == active_term_id),
            }
        )

    return {"ok": True, "active_term_id": active_term_id, "terms": terms}

@router.get("/load-assignment/planning-term")
async def om_load_assignment_planning_term(db=Depends(get_db)):
    """Return the current (is_current=True) term id and the planning term id.

    In OM terminology:
      - current_term_id: the term where terms.is_current == True
      - planning_term_id: the term immediately after the current term (chronological next)

    The Load Assignment screen typically uses the planning term by default, but some UI widgets
    (like Faculty Deloading) may need to explicitly target the planning term.
    """
    cur = await db[COL_TERMS].find_one(
        {"is_current": True},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )
    current_term_id = (cur or {}).get("term_id")

    planning = await _active_term()
    planning_term_id = (planning or {}).get("term_id")

    return {
        "ok": True,
        "current_term_id": current_term_id,
        "planning_term_id": planning_term_id,
    }

@router.get("/load-assignment/list")
async def get_om_load_assignment_list(user_id: str, term_id: Optional[str] = None, db=Depends(get_db)):
    # Default behavior remains: if no term_id is provided, use the OM active term.
    # If a term_id is provided and it is NOT the active term, treat it as an Archived view.
    planning = await _active_term()
    planning_term_id = (planning or {}).get("term_id")

    is_archived_view = False
    if term_id:
        active = await db[COL_TERMS].find_one(
            {"term_id": term_id},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        )
        if not active:
            raise HTTPException(status_code=404, detail="term_id not found")
        is_archived_view = bool(planning_term_id and str(term_id) != str(planning_term_id))
    else:
        active = planning

    # Whether this term's load recommendation has already been forwarded to the Chair.
    # Forwarding is a final act and should remain disabled across refresh/auto-assign.
    forwarded_to_chair = False
    try:
        dept_id_header = "DEPT0001"  # keep existing header behavior used in /om/loadassignment approve
        hdr = await db[COL_FACULTY_LOADS].find_one(
            {"term_id": (active or {}).get("term_id"), "department_id": dept_id_header},
            {"_id": 0, "forwarded_to_chair": 1},
        ) or {}
        forwarded_to_chair = bool(hdr.get("forwarded_to_chair"))
    except Exception:
        forwarded_to_chair = False

    # Fetch table rows
    if not (active or {}).get("term_id"):
        raise HTTPException(status_code=409, detail="No active/upcoming term found")

    base = await _fetch_rows(user_id, term_id=active["term_id"], db=db, archived_view=is_archived_view)
    rows = base["rows"]

    # `selected` is a UI-only flag used by the OM table checkboxes.
    # It must NEVER be treated as persisted data (clean-restores can reintroduce
    # stale `selected: true` values, which can cause the OM "To Faculty" action
    # to include unintended rows).
    if isinstance(rows, list):
        for r in rows:
            if isinstance(r, dict):
                r.pop("selected", None)

    # Overlay: finalized/locked flags from proposals so the OM UI can disable actions
    # (e.g., after per-course finalize or after RFC reject auto-locks the whole schedule).
    try:
        proposals = await db[COL_LOAD_PROPOSALS].find(
            {"term_id": active["term_id"]},
            {"_id": 0, "faculty_id": 1, "rows": 1, "locked": 1},
        ).to_list(None)

        finalized_keys: set[tuple[str, str, str]] = set()
        for p in proposals or []:
            fid = str(p.get("faculty_id") or "").strip()
            if not fid:
                continue
            locked_all = bool(p.get("locked"))
            for rr in (p.get("rows") or []):
                if not isinstance(rr, dict):
                    continue
                course = str(rr.get("course") or rr.get("course_code") or "").strip()
                section = str(rr.get("section") or "").strip()
                if not course or not section:
                    continue
                if locked_all or bool(rr.get("finalized")):
                    finalized_keys.add((fid, course, section))

        if finalized_keys and isinstance(rows, list):
            for r in rows:
                if not isinstance(r, dict):
                    continue
                fid = str(r.get("faculty_id") or "").strip()
                course = str(r.get("course") or "").strip()
                section = str(r.get("section") or "").strip()
                if fid and course and section and (fid, course, section) in finalized_keys:
                    r["finalized"] = True
    except Exception:
        # Best-effort only; do not fail list load if proposals schema differs.
        pass

    # Get faculty preferences for the active term
    ctx = await phase0_load(active["term_id"], db)
    fac_prefs = ctx.prefs_by_faculty or {}

        # --- NEW: maps for campus and course type_of_course (for GE @ CMPS0002 rule) ---
    sections = ctx.sections or []
    courses = ctx.courses or {}

    # section_id -> campus_id
    section_campus: dict[str, str] = {}
    # section_id -> course_id
    section_course: dict[str, str] = {}
    # course_id -> TYPE_OF_COURSE (e.g. "GE")
    course_type_of_course: dict[str, str] = {}

    for s in sections:
        sid = s.get("section_id")
        if not sid:
            continue
        section_campus[sid] = str(s.get("campus_id") or "").strip()
        cid = s.get("course_id")
        if cid:
            section_course[sid] = cid

    for cid, cinfo in (courses or {}).items():
        toc = str(cinfo.get("type_of_course") or "").strip().upper()
        if toc:
            course_type_of_course[cid] = toc

    # --- NEW: program level per course (e.g. 'GS') ---
    course_program_level: dict[str, str] = {}
    for cid, cinfo in (ctx.courses or {}).items():
        lvl = str(cinfo.get("program_level") or "").strip().upper()
        if lvl:
            course_program_level[cid] = lvl  # e.g. "GS", "UG", etc.

    # --- NEW: PhD status per faculty (certifications array contains 'Phd') ---
    faculty_has_phd: dict[str, bool] = {}
    for f in (ctx.faculty or []):
        fid = f.get("faculty_id")
        if not fid:
            continue
        certs = [str(x or "").strip().upper() for x in (f.get("certifications") or [])]
        if "PHD" in certs:
            faculty_has_phd[fid] = True


    # --- faculty pref windows (day + time) for SCHEDULE_PREF_MISMATCH ---
    def _parse_hhmm(s: str) -> int | None:
        """
        Convert '730' or '07:30' etc to minutes since midnight.
        Returns None if invalid.
        """
        if not s:
            return None
        s = s.strip().replace(":", "")
        if not s.isdigit() or len(s) not in (3, 4):
            return None
        if len(s) == 3:
            hh = int(s[0])
            mm = int(s[1:])
        else:
            hh = int(s[:2])
            mm = int(s[2:])
        if not (0 <= hh < 24 and 0 <= mm < 60):
            return None
        return hh * 60 + mm

    faculty_pref_windows: dict[str, list[dict]] = {}
    for fid, pref in fac_prefs.items():
        days = pref.get("availability_days") or []
        times = pref.get("preferred_times") or []  # e.g. "730-900"
        if not days or not times:
            continue

        windows: list[dict] = []
        for d in days:
            d_str = str(d or "").strip().upper()
            if not d_str:
                continue
            for t in times:
                if not isinstance(t, str) or "-" not in t:
                    continue
                left, right = t.replace("–", "-").replace("—", "-").split("-", 1)
                b = _parse_hhmm(left)
                e = _parse_hhmm(right)
                if b is None or e is None or e <= b:
                    continue
                windows.append({"day": d_str, "begin": b, "end": e})

        if windows:
            faculty_pref_windows[fid] = windows

    raw_course_to_kacs = getattr(ctx, "course_to_kacs", {}) or {}

    course_to_kacs_payload: dict[str, list[str]] = {}
    for cid, kset in raw_course_to_kacs.items():
        cid_str = str(cid or "").strip()
        if not cid_str:
            continue

        vals = sorted(
            {
                str(kid or "").strip()
                for kid in (kset or [])
                if str(kid or "").strip()
            }
        )
        if vals:
            course_to_kacs_payload[cid_str] = vals

    # faculty_id -> list of KACs (union of qualified_kacs, kac_ids, preferred_kacs)
    faculty_to_kacs: dict[str, list[str]] = {}
    fac_rows = getattr(ctx, "faculty", []) or []

    for f in fac_rows:
        fid = f.get("faculty_id")
        if not fid:
            continue

        acc: set[str] = set()

        # from faculty_profiles
        for kid in (f.get("qualified_kacs") or []):
            if kid:
                acc.add(kid)
        for kid in (f.get("kac_ids") or []):
            if kid:
                acc.add(kid)

        # from faculty_preferences.preferred_kacs
        pref = fac_prefs.get(fid) or {}
        for kid in (pref.get("preferred_kacs") or []):
            if kid:
                acc.add(kid)

        if acc:
            faculty_to_kacs[fid] = sorted(acc)

    # --- NEW: faculty preferred modes for MODE_MISMATCH flag ---
    faculty_allowed_modes: dict[str, list[str]] = {}
    for fid, pref in fac_prefs.items():
        mode_obj = pref.get("mode") or {}
        mode_str = str(mode_obj.get("mode") or "").strip().upper()
        if fid and mode_str:
            # store as a 1-item list so we can support multi-modes later
            faculty_allowed_modes[fid] = [mode_str]


    # Build preferred units map
    preferred_units_by_faculty = {}
    for fid, pref in fac_prefs.items():
        val = pref.get("preferred_units") or pref.get("load_units")
        try:
            if val:
                preferred_units_by_faculty[fid] = int(val)
        except:
            continue

    campus_blocked = getattr(ctx, "campus_blocked", {}) or {}
    blocked_ge_cmps2: list[dict] = []

    idx_to_day = {1: "M", 2: "T", 3: "W", 4: "H", 5: "F", 6: "S"}
    sec_by_id = {s.get("section_id"): s for s in (ctx.sections or []) if s.get("section_id")}
    section_code_by_id: dict[str, str] = {}
    campus_lookup = {"CMPS0002": "CMPS0002"}  # keep simple; your UI uses Laguna wording anyway

    def _iter_blocked_slots_for_cmps2(campus_blocked: dict):
        cmps2 = campus_blocked.get("CMPS0002") or campus_blocked.get("cmps0002") or {}
        if not isinstance(cmps2, dict):
            return

        def _looks_like_owner_key(k: Any) -> bool:
            # supports actual tuple/list keys OR stringified tuple keys like "('PROG','BATCH')"
            if isinstance(k, (tuple, list)) and len(k) == 2:
                return True
            if isinstance(k, str):
                s = k.strip()
                return s.startswith("(") and s.endswith(")") and "," in s
            return False

        owner_scoped = any(_looks_like_owner_key(k) for k in cmps2.keys())

        if owner_scoped:
            for _owner_key, day_map in cmps2.items():
                if not isinstance(day_map, dict):
                    continue
                for day_idx, slots in day_map.items():
                    if not isinstance(slots, list):
                        continue
                    for slot in slots:
                        yield day_idx, slot
        else:
            for day_idx, slots in cmps2.items():
                if not isinstance(slots, list):
                    continue
                for slot in slots:
                    yield day_idx, slot

    # extract blocked_section_ids (optional, keep if you use it later)
    blocked_section_ids: set[str] = set()
    for _day_idx, slot in _iter_blocked_slots_for_cmps2(campus_blocked):
        if isinstance(slot, (list, tuple)) and len(slot) >= 3:
            sid = str(slot[2] or "").strip()
            if sid:
                blocked_section_ids.add(sid)

    # flatten blocked_ge_cmps2 (ONLY ONCE)
    for day_idx, slot in _iter_blocked_slots_for_cmps2(campus_blocked):
        if not isinstance(slot, (list, tuple)) or len(slot) < 4:
            continue

        try:
            di = int(day_idx)
        except Exception:
            di = None
        day = idx_to_day.get(di, "")

        st_min = slot[0]
        en_min = slot[1]
        sid = str(slot[2] or "").strip()
        cid = str(slot[3] or "").strip()
        sec_code = str(slot[4] or "").strip() if len(slot) >= 5 else ""

        if not sid or not cid:
            continue

        cinfo = courses.get(cid) or {}
        course_code = cinfo.get("course_code") or cinfo.get("course_id") or cid
        sec = sec_by_id.get(sid) or {}
        prog_id = str(sec.get("owner_program_id") or "").strip()
        batch_id = str(sec.get("owner_batch_id") or "").strip()
        section_code = (
            sec_code
            or section_code_by_id.get(sid, "")
            or str(sec.get("section_code") or "").strip()
            or str(sec.get("section") or "").strip()
            or sid
        )

        program_code_by_id: dict[str, str] = {}
        batch_code_by_id: dict[str, str] = {}

        # build from ctx.sections (or from blocked_section_ids)
        prog_ids = set()
        batch_ids = set()
        for s in (ctx.sections or []):
            p = str(s.get("owner_program_id") or "").strip()
            b = str(s.get("owner_batch_id") or "").strip()
            if p: prog_ids.add(p)
            if b: batch_ids.add(b)

        if prog_ids:
            docs = await db["programs"].find(
                {"program_id": {"$in": list(prog_ids)}},
                {"_id": 0, "program_id": 1, "program_code": 1},
            ).to_list(None)
            for d in docs or []:
                program_code_by_id[str(d["program_id"])] = str(d.get("program_code") or "")

        if batch_ids:
            docs = await db["batches"].find(
                {"batch_id": {"$in": list(batch_ids)}},
                {"_id": 0, "batch_id": 1, "batch_code": 1},
            ).to_list(None)
            for d in docs or []:
                batch_code_by_id[str(d["batch_id"])] = str(d.get("batch_code") or "")

        blocked_ge_cmps2.append(
            {
                "campus_id": "CMPS0002",
                "campus_name": campus_lookup.get("CMPS0002", "CMPS0002"),
                "course_id": cid,
                "course_code": course_code,
                "section_id": sid,
                "section_code": section_code,
                "day": day,
                "begin": _mm_to_hhmm(st_min),
                "end": _mm_to_hhmm(en_min),

                "program": program_code_by_id.get(prog_id, prog_id) if prog_id else "",
                "batch": batch_code_by_id.get(batch_id, batch_id) if batch_id else "",
            }
        )
    
    # --- NEW: pending RFC indicator per SECTION (for red dot in Actions) ---
    # RFCs are keyed by (faculty_id + term_id + section_id). The old implementation only keyed by faculty_id,
    # which caused *all* rows of that faculty to show the red dot even if the RFC was for only one section.
    open_rfc_keys: set[tuple[str, str]] = set()
    try:
        cur = db[COL_LOAD_RFC].find(
            {"term_id": active.get("term_id"), "status": {"$in": ["NEEDS_OM", "open", "OPEN"]}},
            {"_id": 0, "faculty_id": 1, "section_id": 1},
        )
        async for d in cur:
            fid = str(d.get("faculty_id") or "").strip()
            sid = str(d.get("section_id") or "").strip()
            if fid and sid:
                open_rfc_keys.add((fid, sid))
    except Exception:
        open_rfc_keys = set()

    for r in rows:
        fid = str(r.get("faculty_id") or "").strip()
        sid = str(r.get("id") or r.get("section_id") or "").strip()
        # Faculty assignments synced from Faculty Service should be treated as already approved.
        # They should not show RFC notifications in OM Load Assignment.
        if bool(r.get("synced_from_faculty_service")):
            r["pending_rfc"] = False
        else:
            r["pending_rfc"] = bool(fid and sid and (fid, sid) in open_rfc_keys)

    # APO-set schedule + faculty encoding deadline window (campus-specific)
    campus_id = (await _infer_campus_id_for_user(user_id, db)) or ""
    om_submit_window = None
    om_submit_windows: list[dict] = []
    om_submit_has_apo_submission = False
    om_submit_deadline_passed = False
    try:
        if campus_id:
            om_submit_window = await _get_om_submit_window(active.get("term_id"), campus_id, db)
            om_submit_has_apo_submission = await _has_apo_submission(active.get("term_id"), campus_id, db)
            om_submit_deadline_passed = _deadline_passed(om_submit_window)

        # Also return BOTH Manila + Laguna windows for display in OM.
        for cid in ["CMPS0001", "CMPS0002"]:
            w = await _get_om_submit_window(active.get("term_id"), cid, db)
            if not w or not (w.get("deadlineISO") or "").strip():
                continue
            cname = cid
            try:
                camp = await db["campuses"].find_one({"campus_id": cid}, {"_id": 0, "campus_name": 1}) or {}
                cname = (camp.get("campus_name") or cid).strip() or cid
            except Exception:
                cname = cid
            has_apo = await _has_apo_submission(active.get("term_id"), cid, db)
            om_submit_windows.append(
                {
                    "campus_id": cid,
                    "campus_name": cname,
                    "openISO": w.get("openISO") or "",
                    "deadlineISO": w.get("deadlineISO") or "",
                    "deadline_passed": _deadline_passed(w),
                    "has_apo_submission": bool(has_apo),
                }
            )
    except Exception:
        pass

    on_leave_faculty_ids: list[str] = []
    try:
        blocked = await _faculty_on_leave_map(db, str(active.get("term_id") or "").strip())
        on_leave_faculty_ids = sorted(list(blocked)) if blocked else []
    except Exception:
        # Best-effort only; never break list load if leave logic fails
        on_leave_faculty_ids = []

    return {
        "term": _term_label(active),
        "term_id": active.get("term_id"),
        "rows": rows,
        "forwarded_to_chair": forwarded_to_chair,
        "campus_id": campus_id,
        "om_submit_window": om_submit_window,
        "om_submit_windows": om_submit_windows,
        "om_submit_deadline_passed": bool(om_submit_deadline_passed),
        "om_submit_has_apo_submission": bool(om_submit_has_apo_submission),
        "preferred_units_by_faculty": preferred_units_by_faculty,
        "on_leave_faculty_ids": on_leave_faculty_ids,
        "courseToKacs": course_to_kacs_payload,
        "facultyToKacs": faculty_to_kacs,
        "facultyAllowedModes": faculty_allowed_modes,
        "facultyPrefWindows": faculty_pref_windows,
        "courseProgramLevel": course_program_level,  
        "facultyHasPhd": faculty_has_phd,
        "sectionCampus": section_campus,
        "sectionCourse": section_course,
        "courseTypeOfCourse": course_type_of_course,
        "blockedGeCmps2": blocked_ge_cmps2,
    }

@router.get("/load-assignment/submitted-courses")
async def om_get_submitted_course_offerings(
    user_id: str,
    term_id: Optional[str] = None,
    db=Depends(get_db),
):
    """Return course options based on submitted course offerings.

    Used by OM "Add new line" Course dropdown.
    - Restricted to the OM's department scope.
    - Restricted to submitted_for_scheduling=True in sections_submitted.
    """
    # Resolve term
    if term_id:
        active = await db[COL_TERMS].find_one(
            {"term_id": term_id},
            {"_id": 0, "term_id": 1},
        )
        if not active:
            raise HTTPException(status_code=404, detail="term_id not found")
    else:
        active = await _active_term()
    if not (active or {}).get("term_id"):
        raise HTTPException(status_code=409, detail="No active/upcoming term found")

    dept_ids = await _loadassignment_department_ids(user_id, db)
    if not dept_ids:
        return {"ok": True, "courses": []}

    tid = active["term_id"]

    # Keep course options aligned with the main OM table: do not consider Special Class sections.
    special_section_ids = await _special_class_section_ids(tid, db)
    pipe: list[dict[str, Any]] = [
        {"$match": {"term_id": tid, "submitted_for_scheduling": True}},
        ({"$match": {"section_id": {"$nin": sorted(list(special_section_ids))}}} if special_section_ids else {"$match": {}}),
        {"$lookup": {"from": COL_COURSES, "localField": "course_id", "foreignField": "course_id", "as": "course"}},
        {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": False}},
        {"$match": {"course.department_id": {"$in": dept_ids}}},
        # IMPORTANT: Do NOT filter by course "type" here.
        # The OM "Add new line" dropdown must show *all* APO-submitted offerings
        # within the OM's department scope (e.g., GE, electives, etc.).
        # Filtering by a partial list (Major/Foundation/SHS/GS) causes valid
        # submitted courses to disappear from the dropdown.
        {
            "$addFields": {
                "course_code_display": {
                    "$cond": [
                        {"$isArray": "$course.course_code"},
                        {"$ifNull": [{"$arrayElemAt": ["$course.course_code", 0]}, ""]},
                        {"$ifNull": ["$course.course_code", ""]},
                    ]
                },
                "course_title_display": {"$ifNull": ["$course.course_title", ""]},
                "course_units_display": {"$ifNull": ["$course.units", {"$ifNull": ["$course.units_per_section", 0]}]},
            }
        },
        # Campus-specific offerings:
        # A course can be offered in both Manila and Laguna. We return one entry per (course_id, campus_id)
        # so the OM "Add section" flow can be restricted by campus deadlines.
        {
            "$group": {
                "_id": {"course_id": "$course.course_id", "campus_id": "$campus_id"},
                "campus_id": {"$first": "$campus_id"},
                "code": {"$first": "$course_code_display"},
                "title": {"$first": "$course_title_display"},
                "units": {"$first": "$course_units_display"},
                # Best-effort: capacity from submitted offerings (max enrollment_cap across sections)
                "capacity": {"$max": {"$ifNull": ["$enrollment_cap", 0]}},
            }
        },
        {"$project": {"_id": 0, "campus_id": 1, "code": 1, "title": 1, "units": 1, "capacity": 1}},
        {"$sort": {"code": 1, "campus_id": 1}},
    ]

    docs = [x async for x in db[COL_SECTIONS_SUBMITTED].aggregate(pipe)]
    # Sanitize
    out: list[dict[str, Any]] = []
    for d in docs or []:
        code = str(d.get("code") or "").strip()
        title = str(d.get("title") or "").strip()
        if not code:
            continue
        try:
            units = int(d.get("units") or 0)
        except Exception:
            units = 0
        try:
            cap = int(d.get("capacity") or 0)
        except Exception:
            cap = 0
        out.append({
            "campus_id": str(d.get("campus_id") or "").strip(),
            "code": code,
            "title": title,
            "units": units,
            "capacity": cap,
        })

    return {"ok": True, "courses": out}

@router.post("/load-assignment/new-line")
async def om_save_new_line(
    user_id: str,
    payload: Dict[str, Any] = Body(...),
    term_id: Optional[str] = None,
    db=Depends(get_db),
):
    """Persist an OM-created inline row ("Add new line") and notify the routed APO.

    Notes:
    - Course must exist in submitted course offerings for the term.
    - Course title is derived from courses.course_title (not user-editable).
    - Rooms are left as TBA; APO will assign rooms.
    """
    # Resolve term
    if term_id:
        active = await db[COL_TERMS].find_one(
            {"term_id": term_id},
            {"_id": 0, "term_id": 1},
        )
        if not active:
            raise HTTPException(status_code=404, detail="term_id not found")
    else:
        active = await _active_term()
    if not (active or {}).get("term_id"):
        raise HTTPException(status_code=409, detail="No active/upcoming term found")
    tid = active["term_id"]

    # Validate required payload fields
    course_code = str(payload.get("course_code") or "").strip()
    section_code = str(payload.get("section_code") or "").strip()
    faculty_id = str(payload.get("faculty_id") or "").strip()
    mode = str(payload.get("mode") or "").strip().upper()
    day1 = str(payload.get("day1") or "").strip().upper()
    begin1 = _norm_hhmm(str(payload.get("begin1") or "").strip())
    end1 = _norm_hhmm(str(payload.get("end1") or "").strip())

    if not course_code or not section_code or not faculty_id or not mode or not day1 or not begin1 or not end1:
        raise HTTPException(status_code=422, detail="Missing required fields")

    # Optional meeting 2
    day2 = str(payload.get("day2") or "").strip().upper()
    begin2 = _norm_hhmm(str(payload.get("begin2") or "").strip())
    end2 = _norm_hhmm(str(payload.get("end2") or "").strip())
    if any([day2, begin2, end2]) and not (day2 and begin2 and end2):
        raise HTTPException(status_code=422, detail="Meeting 2 must include Day 2, Begin 2, and End 2")

    # Course must be in OM scope AND exist in submitted offerings
    dept_ids = await _loadassignment_department_ids(user_id, db)
    if not dept_ids:
        raise HTTPException(status_code=403, detail="OM has no department scope")

    course_doc = await _find_course_by_code(course_code, db)
    if not course_doc:
        raise HTTPException(status_code=404, detail="Course not found")
    if str(course_doc.get("department_id") or "").strip() not in dept_ids:
        raise HTTPException(status_code=403, detail="Course not in OM department scope")

    course_id = str(course_doc.get("course_id") or "").strip()
    if not course_id:
        raise HTTPException(status_code=500, detail="Course is missing course_id")

    # --- APO validation helpers ---
    def _apo_from_section_prefix(sec: str) -> str:
        """Return 'APO Manila' or 'APO Laguna' based on section prefix."""
        s = (sec or "").strip().upper()
        if s.startswith("XX") or s.startswith("XC"):
            return "APO Laguna"
        if s.startswith("S") or s.startswith("G"):
            return "APO Manila"
        return ""

    def _apo_from_campus_id(cid: str) -> str:
        """Best-effort mapping of campus_id -> APO name."""
        c = (cid or "").strip().upper()
        # Project convention observed in other modules: CMPS0001=Manila, CMPS0002=Laguna
        if c == "CMPS0001":
            return "APO Manila"
        if c == "CMPS0002":
            return "APO Laguna"
        return ""

    async def _infer_om_campus_id() -> str:
        """Infer OM campus_id from payload, OM role scope, or term offerings."""
        # 1) explicit payload override
        cid = str(payload.get("campus_id") or "").strip()
        if cid:
            return cid

        # 2) OM role scope (ROLE0006) may include campus scopes
        ra = await db.get_collection("role_assignments").find_one(
            {"user_id": user_id, "role_id": "ROLE0006"},
            {"_id": 0, "scope": 1},
        ) or {}
        for sc in (ra.get("scope") or []):
            if not isinstance(sc, dict):
                continue
            typ = str(sc.get("type") or sc.get("scope_type") or "").strip().lower()
            if typ in ("campus", "campuses") or "campus" in typ:
                v = str(sc.get("id") or sc.get("scope_id") or sc.get("campus_id") or "").strip()
                if v:
                    return v

        # 3) Infer from the submitted offerings for this OM's department scope in the term
        try:
            pipe = [
                {"$match": {"term_id": tid, "submitted_for_scheduling": True}},
                {"$lookup": {"from": COL_COURSES, "localField": "course_id", "foreignField": "course_id", "as": "course"}},
                {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": False}},
                {"$match": {"course.department_id": {"$in": dept_ids}}},
                {"$group": {"_id": "$campus_id", "n": {"$sum": 1}}},
                {"$sort": {"n": -1}},
                {"$limit": 1},
            ]
            top = [x async for x in db[COL_SECTIONS_SUBMITTED].aggregate(pipe)]
            if top and top[0].get("_id"):
                return str(top[0]["_id"]).strip()
        except Exception:
            pass
        return ""

    # Ensure this course exists in submitted offerings for this term (same source as OM table)
    # NOTE: campus_id from the submitted offering is the source of truth for which
    # APO/campus this course offering belongs to. This prevents false Manila/Laguna
    # mismatches when an OM has Manila scope but is editing a Laguna offering (or vice versa).
    offering_exists = await db[COL_SECTIONS_SUBMITTED].find_one(
        {
            "term_id": tid,
            "submitted_for_scheduling": True,
            "course_id": course_id,
        },
        {"_id": 0, "section_id": 1, "campus_id": 1},
    )
    if not offering_exists:
        raise HTTPException(status_code=409, detail="Course is not part of submitted course offerings")

    # 1) Prevent duplicate sections per course (same course_code/course_id) for the active term
    dup = await db[COL_SECTIONS_SUBMITTED].find_one(
        {
            "term_id": tid,
            "submitted_for_scheduling": True,
            "course_id": course_id,
            "section_code": {"$regex": rf"^{re.escape(section_code)}$", "$options": "i"},
        },
        {"_id": 0, "section_id": 1},
    )
    if dup:
        raise HTTPException(status_code=409, detail="Duplicate section: this section already exists for that course")

    # 2) Enforce APO rules based on section prefix AND the course offering's campus.
    # The submitted course offering (sections_submitted) is treated as the source of truth
    # for which campus/APO the course belongs to.
    section_apo = _apo_from_section_prefix(section_code)
    if not section_apo:
        raise HTTPException(
            status_code=409,
            detail="Invalid section: use S/G (APO Manila) or XX/XC (APO Laguna)",
        )

    expected_campus_id = (
        str(payload.get("campus_id") or "").strip()
        or str(offering_exists.get("campus_id") or "").strip()
    )
    expected_apo = _apo_from_campus_id(expected_campus_id)
    if expected_apo and section_apo != expected_apo:
        raise HTTPException(
            status_code=409,
            detail=f"Invalid section: This section belongs to {section_apo}, but you’re assigning for {expected_apo}.",
        )

    # Generate a new section_id in the existing SEC#### format
    ctx = await phase0_load(tid, db, department_id=None)
    seq = _next_section_seq_from_ctx(ctx)
    section_id = f"SEC{seq:04d}"
    # Very defensive: avoid collision
    while await db[COL_SECTIONS].find_one({"section_id": section_id}, {"_id": 0, "section_id": 1}):
        seq += 1
        section_id = f"SEC{seq:04d}"

    # Campus routing: prefer the course offering's campus_id (source of truth),
    # fall back to section-prefix inference for safety.
    campus_id = expected_campus_id or _section_to_campus_id(section_code)

    # NEW: Campus-specific deadline lock.
    # If the APO-set deadline has passed for this campus, OM may not add new sections for it.
    try:
        if campus_id:
            w = await _get_om_submit_window(tid, campus_id, db)
            if _deadline_passed(w):
                raise HTTPException(
                    status_code=403,
                    detail="Cannot add section: the APO-set deadline has passed for this campus",
                )
    except HTTPException:
        raise
    except Exception:
        # Best-effort: do not crash if window lookup fails.
        pass

    # Units/capacity (title is derived)
    try:
        units = int(payload.get("units") or course_doc.get("units") or course_doc.get("units_per_section") or 0)
    except Exception:
        units = 0
    try:
        cap = int(payload.get("capacity") or 0)
    except Exception:
        cap = 0

    remarks = str(payload.get("remarks") or "").strip()

    now = _utcnow()

    # 1) Canonical sections doc (remarks live here)
    await db[COL_SECTIONS].insert_one(
        {
            "section_id": section_id,
            "term_id": tid,
            "course_id": course_id,
            "section_code": section_code,
            "department_id": str(course_doc.get("department_id") or "").strip(),
            "campus_id": campus_id,
            "units": units,
            "enrollment_cap": cap,
            "mode": mode,
            "remarks": remarks,
            "created_source": "OM_NEW_LINE",
            "created_by_user_id": user_id,
            "created_by_office": "OM",
            "created_at": now,
            "updated_at": now,
        }
    )

    # 2) Submitted snapshot (drives OM table)
    await db[COL_SECTIONS_SUBMITTED].insert_one(
        {
            "section_id": section_id,
            "term_id": tid,
            "course_id": course_id,
            "section_code": section_code,
            "submitted_for_scheduling": True,
            "enrollment_cap": cap,
            "campus_id": campus_id,
            "remarks": remarks,
            "created_source": "OM_NEW_LINE",
            "created_by_user_id": user_id,
            "created_by_office": "OM",
            "created_at": now,
            "updated_at": now,
        }
    )

    # 3) Schedules (rooms are left blank/TBA)
    sched_docs: list[dict[str, Any]] = []
    sched_docs.append(
        {
            "schedule_id": _sched_id(section_id, 1),
            "term_id": tid,
            "section_id": section_id,
            "day": day1,
            "start_time": _to_compact_hhmm(begin1),
            "end_time": _to_compact_hhmm(end1),
            "room_id": "",
            "created_at": now,
            "updated_at": now,
        }
    )
    if day2 and begin2 and end2:
        sched_docs.append(
            {
                "schedule_id": _sched_id(section_id, 2),
                "term_id": tid,
                "section_id": section_id,
                "day": day2,
                "start_time": _to_compact_hhmm(begin2),
                "end_time": _to_compact_hhmm(end2),
                "room_id": "",
                "created_at": now,
                "updated_at": now,
            }
        )
    if sched_docs:
        await db[COL_SCHED].insert_many(sched_docs)

    # 4) Faculty assignment (Pending)
    assignment_doc = {
        "assignment_id": f"ASG-{uuid.uuid4().hex[:10].upper()}",
        "load_id": f"LOAD-{uuid.uuid4().hex[:10].upper()}",
        "section_id": section_id,
        "faculty_id": faculty_id,
        "course_id": course_id,
        "term_id": tid,
        "status": "Pending",
        "is_archived": False,
        "synced_from_faculty_service": False,
        "created_at": now,
        "updated_at": now,
    }
    await db[COL_ASSIGN].insert_one(assignment_doc)

    # 5) Notify routed APO (best-effort)
    # IMPORTANT: in-app notification must always be created; Gmail send is best-effort.
    # The previous implementation swallowed any exception and could result in *no* in-app
    # notification when campus routing couldn't resolve recipients.
    details = (
        f"A new section was added by OM and requires room assignment.\n\n"
        f"Course: {course_code} — {str(course_doc.get('course_title') or '').strip()}\n"
        f"Section: {section_code}\n"
        f"Day/Time: {day1} {begin1}-{end1}" + (f"; {day2} {begin2}-{end2}" if day2 and begin2 and end2 else "")
    ).strip()
    meta = {
        # Route must match APO frontend (see APO sidebar).
        # Some UIs filter notifications by route prefix; using an OM-only route can
        # make APO recipients think they did not receive the notification.
        "route": "/apo/courseofferings",
        "kind": "om_new_line",
        "term_id": tid,
        "section_id": section_id,
        "campus_id": campus_id,
    }

    apo_uids: list[str] = []
    try:
        if campus_id:
            apo_uids = await _apo_user_ids_for_campus(campus_id, db)
    except Exception:
        apo_uids = []

    # Fallback: if campus_id is blank or no APOs were found, re-infer using section prefix.
    if not apo_uids:
        try:
            inferred_campus = _section_to_campus_id(section_code)
            if inferred_campus:
                apo_uids = await _apo_user_ids_for_campus(inferred_campus, db)
                meta["campus_id"] = inferred_campus
        except Exception:
            apo_uids = []

    # Final fallback: if campus routing is not configured, notify all APO users.
    if not apo_uids:
        try:
            apo_uids = await _all_apo_user_ids(db)
        except Exception:
            apo_uids = []

    # De-duplicate and never notify the actor.
    try:
        apo_uids = sorted({uid for uid in (apo_uids or []) if uid and uid != user_id})
    except Exception:
        pass

    # Create one notification per APO user.
    # IMPORTANT: in-app notifications must still be created even if Gmail address
    # backfill fails (e.g., legacy accounts). Email sending is already best-effort
    # inside create_notification.
    for uid in apo_uids or []:
        try:
            try:
                # Best-effort: backfill missing users.gmail for legacy accounts.
                await _ensure_user_gmail_address(uid, db)
            except Exception:
                pass

            await create_notification(
                user_id=uid,
                title="New section pending room assignment",
                details=details,
                meta=meta,
                send_email=True,
                email_from_user_id=user_id,
            )
        except Exception:
            # Never fail the save due to notification issues.
            continue

    return {"ok": True, "section_id": section_id}

@router.post("/load-assignment/to-faculty")
async def om_send_to_faculty(payload: Dict[str, Any] = Body(...), db=Depends(get_db)):
    """Send OM proposed schedule(s) to faculty.

    Payload:
      - user_id: OM user id
      - term_id: optional; defaults to OM active term
      - rows: array of OM load rows (frontend already ensures "all rows per selected faculty")

    Behavior:
      - groups rows by faculty_id
      - upserts into faculty_load_proposals
      - creates notification for each faculty
    """
    user_id = payload.get("user_id") or payload.get("userId")
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id is required")

    term_id = payload.get("term_id")
    if not term_id:
        active = await _active_term()
        term_id = (active or {}).get("term_id")

    if not term_id:
        raise HTTPException(status_code=409, detail="No active/upcoming term found")

    rows = payload.get("rows") or []
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=400, detail="rows[] is required")



    # Normalize schedule fields so FACULTY side can reliably render calendar/list views.
    # We KEEP the original OM fields (begin1/end1/etc.) but also populate the faculty-facing
    # schema used by FACULTY_Overview (start/end/time1, start2/end2/time2, course_code/title).
    def _hhmm_to_hm(v: Any) -> str:
        s = ("" if v is None else str(v)).strip()
        if re.fullmatch(r"\d{4}", s):
            return f"{s[:2]}:{s[2:]}"
        return s

    def _norm_row_for_faculty(r: Dict[str, Any]) -> Dict[str, Any]:
        rr = dict(r or {})

        # IMPORTANT: persist a stable section identifier for matching/updates.
        # Older payloads often only have `id`; downstream logic should prefer `section_id`.
        sid = str(rr.get("section_id") or rr.get("id") or "").strip()
        if sid and not str(rr.get("section_id") or "").strip():
            rr["section_id"] = sid
        # course code/title
        rr.setdefault("course_code", (rr.get("course") or rr.get("course_code") or "").strip())
        rr.setdefault("course_title", (rr.get("title") or rr.get("course_title") or rr.get("courseTitle") or "").strip())

        # meeting 1
        b1_raw = rr.get("start") or rr.get("begin1") or rr.get("begin_1") or rr.get("begin")
        e1_raw = rr.get("end") or rr.get("end1") or rr.get("end_1") or rr.get("end")
        b1 = _hhmm_to_hm(b1_raw)
        e1 = _hhmm_to_hm(e1_raw)
        if not rr.get("start") and b1:
            rr["start"] = b1
        if not rr.get("end") and e1:
            rr["end"] = e1
        if not rr.get("time1") and b1 and e1:
            rr["time1"] = f"{b1}–{e1}"

        # meeting 2 (optional)
        b2_raw = rr.get("start2") or rr.get("begin2") or rr.get("begin_2")
        e2_raw = rr.get("end2") or rr.get("end2") or rr.get("end_2")
        b2 = _hhmm_to_hm(b2_raw)
        e2 = _hhmm_to_hm(e2_raw)
        if not rr.get("start2") and b2:
            rr["start2"] = b2
        if not rr.get("end2") and e2:
            rr["end2"] = e2
        if not rr.get("time2") and b2 and e2:
            rr["time2"] = f"{b2}–{e2}"

        return rr

    # group by faculty_id
    by_fid: Dict[str, List[Dict[str, Any]]] = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        fid = (r.get("faculty_id") or "").strip()
        if not fid:
            continue
        by_fid.setdefault(fid, []).append(_norm_row_for_faculty(r))

    if not by_fid:
        raise HTTPException(status_code=400, detail="No rows with faculty_id")

    def _row_key(rr: Dict[str, Any]) -> tuple[str, str, str]:
        """Key used to identify a row inside a proposal doc.

        Prefer section_id when present (most stable), otherwise fall back to (course_code, section).
        """
        section_id = str(rr.get("id") or rr.get("section_id") or "").strip()
        course_code = str(rr.get("course_code") or rr.get("course") or "").strip()
        section = str(rr.get("section") or "").strip()
        return (section_id, course_code, section)

    def _cmp_payload(rr: Dict[str, Any]) -> Dict[str, str]:
        """A reduced, stable comparison view of a row.

        We intentionally compare only schedule-relevant fields so we can detect
        whether a row truly changed since it was last forwarded.
        """
        return {
            "section_id": str(rr.get("id") or rr.get("section_id") or "").strip(),
            "course_code": str(rr.get("course_code") or rr.get("course") or "").strip(),
            "course_title": str(rr.get("course_title") or rr.get("title") or "").strip(),
            "section": str(rr.get("section") or "").strip(),
            "faculty_id": str(rr.get("faculty_id") or "").strip(),
            "day1": str(rr.get("day1") or "").strip(),
            "start": str(rr.get("start") or rr.get("begin1") or "").strip(),
            "end": str(rr.get("end") or rr.get("end1") or "").strip(),
            "room1": str(rr.get("room1") or "").strip(),
            "day2": str(rr.get("day2") or "").strip(),
            "start2": str(rr.get("start2") or rr.get("begin2") or "").strip(),
            "end2": str(rr.get("end2") or rr.get("end2") or "").strip(),
            "room2": str(rr.get("room2") or "").strip(),
            "mode": str(rr.get("mode") or "").strip(),
            "capacity": str(rr.get("capacity") or "").strip(),
            "units": str(rr.get("units") or "").strip(),
        }

    sent = 0
    for fid, fac_rows in by_fid.items():
        fac = await db[COL_FACULTY].find_one({"faculty_id": fid}, {"_id": 0, "user_id": 1}) or {}
        fac_user_id = (fac.get("user_id") or "").strip()

        # Fetch existing proposal so we can append new rows without forcing previously forwarded rows
        # to be re-sent (or re-accepted) unless they were edited.
        existing = await db[COL_LOAD_PROPOSALS].find_one(
            {"faculty_id": fid, "term_id": term_id},
            {"_id": 0, "status": 1, "locked": 1, "rows": 1, "created_at": 1},
        ) or {}

        existing_rows = list(existing.get("rows") or []) if isinstance(existing.get("rows"), list) else []
        existing_by_key: Dict[tuple[str, str, str], Dict[str, Any]] = {}
        existing_index_by_key: Dict[tuple[str, str, str], int] = {}
        for i, rr in enumerate(existing_rows):
            if not isinstance(rr, dict):
                continue
            k = _row_key(rr)
            existing_by_key[k] = rr
            existing_index_by_key[k] = i

        changed = False
        merged_rows = list(existing_rows)
        for rr in fac_rows:
            if not isinstance(rr, dict):
                continue
            k = _row_key(rr)
            prev = existing_by_key.get(k)

            # If no previous row, this is new.
            if not prev:
                merged_rows.append(rr)
                changed = True
                continue

            # If schedule-relevant payload differs, replace in-place.
            if _cmp_payload(prev) != _cmp_payload(rr):
                idx = existing_index_by_key.get(k)
                if idx is not None and 0 <= idx < len(merged_rows):
                    merged_rows[idx] = rr
                else:
                    merged_rows.append(rr)
                changed = True

        # If nothing new/changed for this faculty, do not touch the proposal doc or notify.
        if not changed and existing_rows:
            continue

        now = datetime.now(timezone.utc)
        prior_status = str(existing.get("status") or "").strip() or "proposed"
        # Any new/changed rows requires faculty attention; set status back to proposed.
        next_status = "proposed" if changed else prior_status

        doc = {
            "faculty_id": fid,
            "term_id": term_id,
            "status": next_status,
            "om_user_id": user_id,
            "rows": merged_rows,
            "locked": False,
            "updated_at": now,
        }

        await db[COL_LOAD_PROPOSALS].update_one(
            {"faculty_id": fid, "term_id": term_id},
            {"$set": doc, "$setOnInsert": {"created_at": now}},
            upsert=True,
        )

        if fac_user_id:
            # Backfill missing users.gmail (some Faculty accounts only have users.email).
            await _ensure_user_gmail_address(fac_user_id, db)
            # Send BOTH in-app + Gmail notification (best-effort) using the OM's connected Gmail.
            await create_notification(
                user_id=fac_user_id,
                title="Load Assignment: Proposed schedule updated",
                details="The Office Manager sent additional or updated load rows for you. You can review them and accept or request changes (RFC).",
                meta={
                    "route": "/faculty/overview",
                    "kind": "load_proposed",
                    "term_id": term_id,
                    "faculty_id": fid,
                },
                send_email=True,
                email_from_user_id=user_id,
            )

        sent += 1

    return {"ok": True, "term_id": term_id, "sent_faculty": sent}

@router.get("/load-assignment/rfc")
async def om_get_rfc(
    faculty_id: str = Query(...),
    term_id: Optional[str] = Query(None),
    section_id: Optional[str] = Query(None),
    db=Depends(get_db),
):
    if not term_id:
        active = await _active_term()
        term_id = (active or {}).get("term_id")

    if not term_id:
        return {"ok": True, "rfc": None}

    q = {"faculty_id": faculty_id, "term_id": term_id}
    if section_id and section_id.strip():
        q["section_id"] = section_id.strip()

    rfc = await db[COL_LOAD_RFC].find_one(q, {"_id": 0})
    if not rfc:
        return {"ok": True, "rfc": None}

    return {"ok": True, "rfc": _normalize_rfc_doc(rfc)}

@router.post("/load-assignment/rfc/respond")
async def respond_load_assignment_rfc(
    payload: Dict[str, Any] = Body(...),
    db=Depends(get_db),
):
    user_id = (payload.get("user_id") or payload.get("userId") or "").strip()
    term_id = (payload.get("term_id") or "").strip()
    faculty_id = (payload.get("faculty_id") or "").strip()
    section_id = (payload.get("section_id") or payload.get("sectionId") or "").strip()
    action = (payload.get("action") or "").strip().lower()
    message = (payload.get("message") or "").strip()

    if not user_id:
        raise HTTPException(status_code=400, detail="user_id is required")
    if not term_id or not faculty_id:
        raise HTTPException(status_code=400, detail="term_id and faculty_id are required")
    if action not in {"reply", "approve", "reject"}:
        raise HTTPException(status_code=400, detail="Invalid action")
    if action == "reply" and not message:
        raise HTTPException(status_code=400, detail="message is required for reply")

    # ✅ RFC key (isolated per subject when section_id is present)
    qkey: Dict[str, Any] = {"faculty_id": faculty_id, "term_id": term_id}
    if section_id:
        qkey["section_id"] = section_id

    # Find RFC (if section_id missing, fallback to latest for faculty+term)
    if section_id:
        rfc = await db[COL_LOAD_RFC].find_one(qkey, {"_id": 0})
    else:
        lst = await db[COL_LOAD_RFC].find(
            {"faculty_id": faculty_id, "term_id": term_id},
            {"_id": 0},
        ).sort([("updated_at", -1), ("created_at", -1)]).to_list(1)
        rfc = lst[0] if lst else None

    if not rfc:
        raise HTTPException(status_code=404, detail="No RFC found")

    rfc = _normalize_rfc_doc(rfc)
    # Only treat as locked when the explicit `locked` flag is set.
    # Terminal statuses are informational and should not prevent continued edits/RFC.
    if bool(rfc.get("locked")):
        raise HTTPException(status_code=409, detail="RFC is already locked")

    now = datetime.now(timezone.utc)
    msgs = list(rfc.get("messages") or [])

    if message:
        msgs.append({
            "sender_role": "om",
            "sender_user_id": user_id,
            "message": message,
            "created_at": now.isoformat(),
        })

    new_status = rfc.get("status")
    locked = False
    extra: Dict[str, Any] = {}

    if action == "reply":
        new_status = "NEEDS_FACULTY"
        locked = False
    elif action == "approve":
        new_status = "APPROVED"
        # Do NOT lock RFC/schedule on approval. Faculty and OM must be able to continue editing / RFC again.
        locked = False
        extra["closed_at"] = now

        # RFC APPROVED → notify faculty only.
        # IMPORTANT: Do NOT change proposal/schedule status here; it becomes "Approved" only when faculty accepts.

        # --- AUTO-APPLY APPROVED RFC (day/time changes) ---
        # When OM approves an RFC that includes requested schedule details,
        # immediately reflect it in:
        #   1) section_schedules (so OM list refresh shows the change)
        #   2) faculty_load_proposals rows (so faculty calendar/list updates)
        # Backwards compatible: if structured `requested` is missing, attempt
        # to parse it from the latest faculty RFC message.
        def _norm_day_code(v: str) -> str:
            s = str(v or '').strip()
            if not s:
                return ''
            u = s.upper()
            # already short code
            if u in ('M','T','W','H','F','S','U','TH'):
                return 'H' if u in ('H','TH') else u
            low = s.lower()
            if low.startswith('mon'): return 'M'
            if low.startswith('tue'): return 'T'
            if low.startswith('wed'): return 'W'
            if low.startswith('thu'): return 'H'
            if low.startswith('fri'): return 'F'
            if low.startswith('sat'): return 'S'
            if low.startswith('sun'): return 'U'
            # fallback: first char
            ch = u[:1]
            return 'H' if ch == 'T' and u.startswith('TH') else ch

        def _split_time_range(v: str) -> tuple[str, str]:
            s = str(v or '').strip()
            if not s:
                return ('','')
            # normalize various dashes
            s = s.replace('—', '–').replace('-', '–')
            parts = [p.strip() for p in s.split('–') if p.strip()]
            if len(parts) >= 2:
                b, e = parts[0], parts[1]
            else:
                # fallback: '07:30 to 09:00'
                parts2 = re.split(r"\s+to\s+", s, flags=re.I)
                b, e = (parts2[0].strip(), parts2[1].strip()) if len(parts2) >= 2 else ('','')
            b2 = _norm_hhmm(b) or ''
            e2 = _norm_hhmm(e) or ''
            return (b2, e2)

        def _extract_requested_from_messages(msgs: list[dict]) -> dict:
            # Find the latest faculty message containing REQUESTED SCHEDULE
            for mm in reversed(msgs or []):
                if not isinstance(mm, dict):
                    continue
                if str(mm.get('sender_role') or '').lower() != 'faculty':
                    continue
                text = str(mm.get('message') or '')
                if 'REQUESTED SCHEDULE' not in text.upper():
                    continue
                req = {}
                lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
                # locate index
                try:
                    idx = next(i for i,ln in enumerate(lines) if ln.upper().startswith('REQUESTED SCHEDULE'))
                except StopIteration:
                    idx = -1
                if idx >= 0:
                    for ln in lines[idx+1:]:
                        m1 = re.search(r"Meeting\s*1:\s*Day\s*(.*?)\s*\|\s*Time\s*(.*)", ln, flags=re.I)
                        if m1:
                            req['day1'] = m1.group(1).strip()
                            req['time1'] = m1.group(2).strip()
                            continue
                        m2 = re.search(r"Meeting\s*2:\s*Day\s*(.*?)\s*\|\s*Time\s*(.*)", ln, flags=re.I)
                        if m2:
                            req['day2'] = m2.group(1).strip()
                            req['time2'] = m2.group(2).strip()
                            continue
                        # stop if another section
                        if ln.upper().startswith('REMARKS'):
                            break
                return req
            return {}

        applied = False
        try:
            requested = rfc.get('requested') if isinstance(rfc, dict) else None
            if not isinstance(requested, dict):
                requested = {}
            if not requested:
                requested = _extract_requested_from_messages(msgs)

            if section_id and (requested.get('day1') or requested.get('time1') or requested.get('day2') or requested.get('time2')):
                d1 = _norm_day_code(requested.get('day1') or '')
                d2 = _norm_day_code(requested.get('day2') or '')
                b1, e1 = _split_time_range(requested.get('time1') or '')
                b2, e2 = _split_time_range(requested.get('time2') or '')

                # Only apply when we have at least meeting 1 day+time
                if d1 and b1 and e1:
                    now2 = datetime.now(timezone.utc)

                    def _compact(hhmm: str) -> str:
                        return _to_compact_hhmm(hhmm) if hhmm else ''

                    # Update section_schedules (preserve room_id/room_type)
                    await db[COL_SCHED].update_one(
                        {'schedule_id': _sched_id(section_id, 1)},
                        {'$set': {'term_id': term_id, 'section_id': section_id, 'day': d1, 'start_time': _compact(b1), 'end_time': _compact(e1), 'updated_at': now2}},
                        upsert=True,
                    )
                    if d2 and b2 and e2:
                        await db[COL_SCHED].update_one(
                            {'schedule_id': _sched_id(section_id, 2)},
                            {'$set': {'term_id': term_id, 'section_id': section_id, 'day': d2, 'start_time': _compact(b2), 'end_time': _compact(e2), 'updated_at': now2}},
                            upsert=True,
                        )
                    else:
                        # Clear meeting 2 if explicitly requested as blank/TBA
                        await db[COL_SCHED].update_one(
                            {'schedule_id': _sched_id(section_id, 2)},
                            {'$set': {'term_id': term_id, 'section_id': section_id, 'day': d2 or '', 'start_time': _compact(b2), 'end_time': _compact(e2), 'updated_at': now2}},
                            upsert=True,
                        )

                    # Update proposal row for faculty (best-effort)
                    # Keep both faculty schema (start/end/time1) and OM schema (begin1/end1)
                    time1_disp = requested.get('time1') or (f"{b1} – {e1}" if (b1 and e1) else '')
                    time2_disp = requested.get('time2') or (f"{b2} – {e2}" if (b2 and e2) else '')

                    await db[COL_LOAD_PROPOSALS].update_one(
                        {'faculty_id': faculty_id, 'term_id': term_id},
                        {
                            '$set': {
                                'rows.$[row].day1': d1,
                                'rows.$[row].day2': d2 or '',
                                'rows.$[row].start': b1,
                                'rows.$[row].end': e1,
                                'rows.$[row].start2': b2,
                                'rows.$[row].end2': e2,
                                'rows.$[row].time1': time1_disp,
                                'rows.$[row].time2': time2_disp,
                                'rows.$[row].begin1': _compact(b1),
                                'rows.$[row].end1': _compact(e1),
                                'rows.$[row].begin2': _compact(b2),
                                'rows.$[row].end2': _compact(e2),
                                'updated_at': now2,
                            }
                        },
                        array_filters=[{'row.section_id': section_id}],
                    )

                    # Persist requested block on RFC doc too (normalized)
                    await db[COL_LOAD_RFC].update_one(
                        qkey,
                        {'$set': {'requested': {'day1': d1, 'time1': requested.get('time1') or time1_disp, 'day2': d2, 'time2': requested.get('time2') or time2_disp}, 'updated_at': now2}},
                        upsert=True,
                    )

                    applied = True
        except Exception:
            # Best-effort only; RFC approval should still succeed even if apply fails.
            applied = False

    else:
        new_status = "REJECTED"
        # Keep the RFC closed, but do not hard-lock the workflow.
        locked = False
        extra["closed_at"] = now

        # ✅ Reject behavior (hybrid):
        # - If RFC is tied to a specific section (section_id provided), finalize ONLY that row.
        # - If RFC is schedule-wide (no section_id), treat it as terminal and lock/finalize the whole schedule.
        if section_id:
            try:
                await db[COL_LOAD_PROPOSALS].update_one(
                    {"faculty_id": faculty_id, "term_id": term_id},
                    {"$set": {"rows.$[row].finalized": True, "updated_at": now}},
                    array_filters=[{"row.section_id": section_id}],
                )
            except Exception:
                pass
        else:
            # Schedule-wide RFC reject should not freeze the whole schedule.
            # Keep the proposal editable; OM can re-send and faculty can RFC again.
            try:
                await db[COL_LOAD_PROPOSALS].update_one(
                    {"faculty_id": faculty_id, "term_id": term_id},
                    {
                        "$set": {
                            "locked": False,
                            "updated_at": now,
                        },
                        "$setOnInsert": {"created_at": now},
                    },
                    upsert=True,
                )
            except Exception:
                pass

    rfc_id = rfc.get("rfc_id")

    # ✅ Update only this RFC thread (qkey includes section_id when present)
    await db[COL_LOAD_RFC].update_one(
        qkey,
        {
            "$set": {
                "rfc_id": rfc_id,
                "faculty_id": faculty_id,
                "term_id": term_id,
                "section_id": section_id or rfc.get("section_id"),
                "status": new_status,
                "locked": locked,
                "messages": msgs,
                "updated_at": now,
                **extra,
            },
            "$setOnInsert": {"created_at": now},
        },
        upsert=True,
    )

    # notify faculty
    fac = await db[COL_FACULTY].find_one(
        {"faculty_id": faculty_id},
        {"_id": 0, "user_id": 1},
    ) or {}
    fac_user_id = (fac.get("user_id") or "").strip()

    if fac_user_id:
        # Backfill missing users.gmail (some Faculty accounts only have users.email).
        await _ensure_user_gmail_address(fac_user_id, db)

        # Detect whether this RFC belongs to a Special Class thread.
        # In Special Class, the frontend reuses this RFC API but passes special_id as `section_id`.
        # If we treat it as a real section_id, the notification deep-link and labeling are wrong,
        # and faculty may not find the conversation from the notification.
        is_special_class = False
        special_doc: Dict[str, Any] = {}
        if section_id:
            try:
                special_doc = await db["special_class"].find_one(
                    {"special_id": section_id},
                    {"_id": 0, "special_id": 1, "course_id": 1, "course_code": 1, "section": 1, "section_code": 1, "term_id": 1},
                ) or {}
                is_special_class = bool(special_doc)
            except Exception:
                is_special_class = False
                special_doc = {}

        # Best-effort: include the specific course + section in the notification body
        # so both in-app and Gmail messages are self-contained.
        course_code = ""
        section_code = ""
        course_section_line = ""
        if section_id:
            try:
                if is_special_class:
                    # Special Class rows often store a course_code/section_code directly.
                    cc = special_doc.get("course_code") or ""
                    if isinstance(cc, list):
                        cc = cc[0] if cc else ""
                    course_code = str(cc or "").strip()
                    section_code = str(special_doc.get("section_code") or special_doc.get("section") or "").strip()

                    cid = str(special_doc.get("course_id") or "").strip()
                    if not course_code and cid:
                        cdoc = await db[COL_COURSES].find_one({"course_id": cid}, {"_id": 0, "course_code": 1}) or {}
                        cc2 = cdoc.get("course_code") or ""
                        if isinstance(cc2, list):
                            cc2 = cc2[0] if cc2 else ""
                        course_code = str(cc2 or "").strip()
                else:
                    sec = await db[COL_SECTIONS].find_one(
                        {"section_id": section_id},
                        {"_id": 0, "section_code": 1, "course_id": 1, "course_code": 1, "section": 1, "course": 1},
                    ) or {}

                    section_code = str(sec.get("section_code") or sec.get("section") or "").strip()

                    cc = sec.get("course_code") or sec.get("course") or ""
                    if isinstance(cc, list):
                        cc = cc[0] if cc else ""
                    course_code = str(cc or "").strip()

                    cid = str(sec.get("course_id") or "").strip()
                    if not course_code and cid:
                        cdoc = await db[COL_COURSES].find_one({"course_id": cid}, {"_id": 0, "course_code": 1}) or {}
                        cc2 = cdoc.get("course_code") or ""
                        if isinstance(cc2, list):
                            cc2 = cc2[0] if cc2 else ""
                        course_code = str(cc2 or "").strip()

                if course_code or section_code:
                    label = " – ".join([p for p in [course_code, section_code] if p])
                    course_section_line = f"Course/Section: {label}\n\n"
            except Exception:
                course_section_line = ""

        # Build a correct faculty deep-link + labels for Special Class vs regular load.
        if is_special_class:
            base_route = f"/faculty/overview?view=Special&open_special_rfc=1&term_id={term_id}&faculty_id={faculty_id}&special_id={section_id}&rfc_id={rfc_id}"
            title_prefix = "Special Class"
            kind_prefix = "special_class_rfc"
        else:
            base_route = f"/faculty/overview?open_rfc=1&term_id={term_id}&faculty_id={faculty_id}&section_id={section_id}&rfc_id={rfc_id}"
            title_prefix = "Load Assignment"
            kind_prefix = "load_rfc"

        if action == "reply":
            title = f"{title_prefix}: OM replied to your Request for Change"
            details = (course_section_line + message).strip()
            kind = f"{kind_prefix}_reply"
        elif action == "approve":
            title = f"{title_prefix}: OM approved your request"
            if message:
                details = (course_section_line + message).strip()
            else:
                details = (course_section_line + "Your Request for Change was approved.").strip()
                # If the RFC contained schedule details, we auto-applied them on approval.
                try:
                    if 'applied' in locals() and applied:
                        details = (course_section_line + "Your Request for Change was approved and the requested schedule was applied.").strip()
                except Exception:
                    pass
            kind = f"{kind_prefix}_approved"
        else:
            title = f"{title_prefix}: OM rejected your request"
            details = (course_section_line + (message or "Your Request for Change was rejected.")).strip()
            kind = f"{kind_prefix}_rejected"

        # Send BOTH in-app + Gmail notification (best-effort) using the OM's connected Gmail.
        await create_notification(
            user_id=fac_user_id,
            title=title,
            details=details,
            meta={
                # Deep-link Faculty to the RFC thread (and the specific course row)
                # so they don't need to hunt for it manually.
                "route": base_route,
                "kind": kind,
                "term_id": term_id,
                "faculty_id": faculty_id,
                "section_id": section_id,
                "rfc_id": rfc_id,
                "course_code": course_code,
                "section_code": section_code,
                "is_special_class": is_special_class,
            },
            send_email=True,
            email_from_user_id=user_id,
        )

    return {"ok": True, "status": new_status}

@router.post("/load-assignment/finalize-course")
async def om_finalize_course(payload: Dict[str, Any] = Body(...), db=Depends(get_db)):
    """Notify a faculty that a course is added to their final schedule."""
    user_id = (payload.get("user_id") or payload.get("userId") or "").strip()
    faculty_id = payload.get("faculty_id")
    course_code = payload.get("course_code") or payload.get("course")
    section = payload.get("section")
    term_id = payload.get("term_id")

    if not user_id or not faculty_id or not course_code or not section:
        raise HTTPException(status_code=400, detail="user_id, faculty_id, course_code and section are required")

    if not term_id:
        active = await _active_term()
        term_id = (active or {}).get("term_id")

    fac = await db[COL_FACULTY].find_one({"faculty_id": faculty_id}, {"_id": 0, "user_id": 1}) or {}
    fac_user_id = (fac.get("user_id") or "").strip()

    if fac_user_id:
        # Backfill missing users.gmail (some Faculty accounts only have users.email).
        await _ensure_user_gmail_address(fac_user_id, db)

        # Best-effort: include the specific course + section in the notification body
        # so both in-app and Gmail messages are self-contained.
        course_code = ""
        section_code = ""
        course_section_line = ""
        if section_id:
            try:
                sec = await db[COL_SECTIONS].find_one(
                    {"section_id": section_id},
                    {"_id": 0, "section_code": 1, "course_id": 1, "course_code": 1, "section": 1, "course": 1},
                ) or {}

                section_code = str(sec.get("section_code") or sec.get("section") or "").strip()

                cc = sec.get("course_code") or sec.get("course") or ""
                if isinstance(cc, list):
                    cc = cc[0] if cc else ""
                course_code = str(cc or "").strip()

                cid = str(sec.get("course_id") or "").strip()
                if not course_code and cid:
                    cdoc = await db[COL_COURSES].find_one({"course_id": cid}, {"_id": 0, "course_code": 1}) or {}
                    cc2 = cdoc.get("course_code") or ""
                    if isinstance(cc2, list):
                        cc2 = cc2[0] if cc2 else ""
                    course_code = str(cc2 or "").strip()

                if course_code or section_code:
                    label = " – ".join([p for p in [course_code, section_code] if p])
                    course_section_line = f"Course/Section: {label}\n\n"
            except Exception:
                course_section_line = ""

        # Send BOTH in-app + Gmail notification (best-effort) using the OM's connected Gmail.
        await create_notification(
            user_id=fac_user_id,
            title="Load Assignment: Added to final schedule",
            details=f"{course_code} – {section} has been added to your final schedule.",
            meta={
                "route": "/faculty/overview",
                "kind": "load_course_finalized",
                "term_id": term_id,
                "faculty_id": faculty_id,
                "course_code": course_code,
                "section": section,
            },
            send_email=True,
            email_from_user_id=user_id,
        )

    # Best-effort: mark finalized in proposal doc
    try:
        await db[COL_LOAD_PROPOSALS].update_one(
            {"faculty_id": faculty_id, "term_id": term_id},
            {
                "$addToSet": {"finalized": {"course_code": course_code, "section": section}},
                "$set": {"updated_at": datetime.now(timezone.utc)},
                "$setOnInsert": {"created_at": datetime.now(timezone.utc)},
            },
            upsert=True,
        )
        await db[COL_LOAD_PROPOSALS].update_one(
            {"faculty_id": faculty_id, "term_id": term_id},
            {"$set": {"rows.$[r].finalized": True}},
            array_filters=[{"r.course": course_code, "r.section": section}],
        )
    except Exception:
        pass

    try:
        await _notify_apo_room_allocation_ready(
            db=db,
            om_user_id=user_id,
            term_id=term_id,
            faculty_id=faculty_id,
            course_code=course_code,
            section_code=section,
        )
    except Exception:
        pass

    # --- Mark the underlying section as OM-approved/room-allocation-ready ---
    # Used by APO (per campus) to know which sections are ready for room assignment.
    try:
        # Best-effort resolve the section_id.
        sec_doc = await db[COL_SECTIONS].find_one(
            {"term_id": term_id, "section_code": section},
            {"_id": 0, "section_id": 1, "campus_id": 1, "course_id": 1},
        )

        # If section_code isn't unique across campuses, narrow by course_code when possible.
        if (not sec_doc) and course_code:
            c = await db[COL_COURSES].find_one(
                {"$or": [{"course_code": course_code}, {"course_code": [course_code]}]},
                {"_id": 0, "course_id": 1},
            )
            cid = (c or {}).get("course_id")
            if cid:
                sec_doc = await db[COL_SECTIONS].find_one(
                    {"term_id": term_id, "course_id": cid, "section_code": section},
                    {"_id": 0, "section_id": 1, "campus_id": 1, "course_id": 1},
                )

        section_id = str((sec_doc or {}).get("section_id") or "").strip()
        if section_id:
            ts = datetime.now(timezone.utc).replace(microsecond=0).isoformat()

            # Ensure campus_id exists (fallback derived from section_code).
            campus_id = str((sec_doc or {}).get("campus_id") or "").strip()
            if not campus_id:
                try:
                    campus_id = await _section_to_campus_id(section, db)
                except Exception:
                    campus_id = ""

            await db[COL_SECTIONS].update_one(
                {"section_id": section_id},
                {"$set": {
                    "om_approved": True,
                    "om_approved_at": ts,
                    "om_approved_by": user_id,
                    "room_allocation_ready": True,
                    "room_allocation_ready_at": ts,
                    "room_allocation_ready_by": user_id,
                    **({"campus_id": campus_id} if campus_id else {}),
                    "updated_at": ts,
                }},
            )

            # Keep snapshot in sync (some OM/APO screens read from sections_submitted).
            try:
                q = {"term_id": term_id, "section_id": section_id}
                if campus_id:
                    q["campus_id"] = campus_id
                await db[COL_SECTIONS_SUBMITTED].update_one(
                    q,
                    {"$set": {
                        "om_approved": True,
                        "om_approved_at": ts,
                        "om_approved_by": user_id,
                        "room_allocation_ready": True,
                        "room_allocation_ready_at": ts,
                        "room_allocation_ready_by": user_id,
                        "updated_at": ts,
                    }},
                )
            except Exception:
                pass

            # Notify OM (self) that the row was approved and forwarded for room allocation.
            # APO receives a separate notification via _notify_apo_room_allocation_ready().
            try:
                await create_notification(
                    user_id=user_id,
                    title="Load Assignment Approved",
                    details=f"{course_code} – {section} is approved and ready for room allocation.",
                    meta={
                        "route": "/om/load-assignment",
                        "kind": "om_load_approved",
                        "term_id": term_id,
                        "section_id": section_id,
                        "course_code": course_code,
                        "section_code": section,
                    },
                    send_email=True,
                    email_from_user_id=user_id,
                )
            except Exception:
                pass
    except Exception:
        pass

    return {"ok": True, "course_code": course_code, "section": section}

@router.post("/load-assignment/run")
async def run_auto_assignment(
    user_id: str | None = Query(None, alias="user_id"),
    department_id: str | None = Query(None),
    term_id: str | None = Query(None),
    payload: Optional[Dict[str, Any]] = Body(None),
    db = Depends(get_db),
):
    # Accept either query parameters (legacy) or a JSON body (newer clients).
    if not user_id and isinstance(payload, dict):
        user_id = (payload.get("user_id") or payload.get("userId") or "").strip() or None
    if not department_id and isinstance(payload, dict):
        department_id = (payload.get("department_id") or payload.get("departmentId") or None)
    if not term_id and isinstance(payload, dict):
        term_id = (payload.get("term_id") or payload.get("termId") or None)

    if not user_id:
        raise HTTPException(status_code=400, detail="user_id is required")

    active = await _active_term()
    if not active:
        raise HTTPException(409, "No upcoming term found (is_current anchor missing?)")

    # Auto-assign must run on the active term.
    # If the client provides a term_id and it doesn't match the active one, fail fast
    # to avoid wiping the UI table with an empty/mismatched term payload.
    requested_term_id = (term_id or "").strip()
    if requested_term_id and requested_term_id != active.get("term_id"):
        raise HTTPException(
            409,
            f"Auto-assign is only available for the active term ({active.get('term_id')}). "
            f"You are currently viewing term {requested_term_id}. Please switch back to the active term.",
        )

    # Canonical term id for this run
    term_id = str(active.get("term_id") or "").strip() or None
    if not term_id:
        raise HTTPException(409, "Active term is missing term_id")

    # Require finished prefs for the upcoming term
    pref_cnt = await db[COL_PREFERENCES].count_documents(
        {"term_id": term_id, "is_finished": True}
    )
    if pref_cnt == 0:
        raise HTTPException(
            409,
            f"No faculty preferences submitted yet for upcoming term {active['term_id']}. "
            "Auto-assign is disabled until submissions exist."
        )

    base = await _fetch_rows(user_id, term_id=term_id, db=db)
    rows = [dict(r) for r in base["rows"]]

    rows_by_id: dict[str, dict] = {
        str(r.get("id")): r for r in rows if r.get("id")
    }

    # ---------- identify locked/manual sections to preserve ----------
    locked_section_ids: set[str] = set()
    for r in rows:
        sid = r.get("id")
        if not sid:
            continue
        if _row_is_locked(r):
            locked_section_ids.add(sid)
    # ----------------------------------------------------------------------

    # Prefs (used for alt-window search on duplicates)
    # Resolve OM department if not explicitly provided
    if not department_id:
        om_dept_ids = await _loadassignment_department_ids(user_id, db)
        if not om_dept_ids:
            raise HTTPException(
                status_code=403,
                detail="Office Manager department not found"
            )
        department_id = om_dept_ids[0]  # OM should only see one dept

    ctx_for_prefs = await phase0_load(
        term_id,
        db,
        department_id=department_id
    )

    fac_prefs = ctx_for_prefs.prefs_by_faculty or {}

    # Build a quick map → faculty_id -> preferred_mode (from faculty_preferences.mode.mode)
    fac_pref_mode: dict[str, str] = {}
    for fid, pref in (ctx_for_prefs.prefs_by_faculty or {}).items():
        mode_obj = pref.get("mode") or {}
        mode_str = str(mode_obj.get("mode") or "").strip().upper()
        if fid and mode_str:
            fac_pref_mode[fid] = mode_str

    # Build a quick map → faculty_id -> preferred_units (or load_units fallback)
    preferred_units_by_faculty: dict[str, int] = {}
    for fid, pref in fac_prefs.items():
        val = pref.get("preferred_units") or pref.get("load_units")
        try:
            if val is not None:
                preferred_units_by_faculty[fid] = int(val)
        except (TypeError, ValueError):
            # ignore bad values; you can also default to 12 if you want
            continue

    prefs_debug = {
        "preferred_units_by_faculty": preferred_units_by_faculty
    }

    # NEW: section_id → campus_id and course_room_type
    sid_to_campus: dict[str, str] = {
        s["section_id"]: str(s.get("campus_id") or "")
        for s in (ctx_for_prefs.sections or [])
        if s.get("section_id")
    }
    sid_to_course: dict[str, str] = {
        s["section_id"]: s.get("course_id")
        for s in (ctx_for_prefs.sections or [])
        if s.get("section_id") and s.get("course_id")
    }
    sid_to_crt: dict[str, str] = {}
    for sid, cid in sid_to_course.items():
        c = (ctx_for_prefs.courses or {}).get(cid, {})
        rt = str(c.get("room_type") or "").strip()
        sid_to_crt[sid] = rt  # e.g., "Classroom", "Comlab", "Online", or ""

    # --- NEW: course tier helper for conflict resolution ---
    def _course_tier_for_sid(section_id: str) -> int:
        """
        Lower = higher priority when resolving clashes.
        Foundation (0) < Major (1) < SHS (2) < everything else (3).
        """
        cid = sid_to_course.get(section_id)
        if not cid:
            return 3
        cinfo = (ctx_for_prefs.courses or {}).get(cid) or {}
        t = str(cinfo.get("type") or cinfo.get("type_of_course") or "Major").strip().upper()
        if t == "FOUNDATION":
            return 0
        if t == "MAJOR":
            return 1
        if t == "SHS":
            return 2
        return 3

    # Track used slots per faculty to avoid duplicates
    used: dict[str, set[tuple[str, str, str]]] = {}

    def _add_used(fid: str | None, day: str | None, b: str | None, e: str | None):
        if fid and day and b and e:
            used.setdefault(str(fid), set()).add((day.upper(), str(b), str(e)))

    def _would_reuse(fid, day, b, e):
        if not (fid and day and b and e):
            return False
        return (day.upper(), str(b), str(e)) in used.get(str(fid), set())

    def _parse_win_to_hhmm_pair(win) -> tuple[str, str] | None:
        st = _to_min(win.get("start") or win.get("begin")) if isinstance(win, dict) else None
        en = _to_min(win.get("end") or win.get("finish")) if isinstance(win, dict) else None
        if isinstance(win, (list, tuple)) and len(win) == 2:
            st, en = _to_min(win[0]), _to_min(win[1])
        if isinstance(win, str) and "-" in win:
            a, b = win.replace("–", "-").replace("—", "-").split("-", 1)
            st, en = _to_min(a), _to_min(b)
        return (_mm_to_hhmm(st), _mm_to_hhmm(en)) if (st is not None and en is not None and st >= 0 and en > st) else None

    def _streak_violation_for(fid: str, day: str, b_hhmm: str, e_hhmm: str) -> bool:
        """Return True if adding (day, b_hhmm, e_hhmm) creates a >4.5h streak."""
        if not (fid and day and b_hhmm and e_hhmm):
            return False

        st_min = _to_min(b_hhmm)
        en_min = _to_min(e_hhmm)
        if st_min is None or en_min is None or en_min <= st_min:
            return False

        day_key = day.upper().strip()
        existing: list[tuple[int, int]] = []
        for (d0, b0, e0) in used.get(fid, set()):
            if d0.upper().strip() == day_key:
                eb = _to_min(b0)
                ee = _to_min(e0)
                if eb is not None and ee is not None and ee > eb:
                    existing.append((eb, ee))

        # True means “this would violate the rule”
        return not _streak_ok_for_day(existing, [(st_min, en_min)])

    # Standard grid you listed
    GRID = [
        ("07:30", "09:00"),
        ("09:15", "10:45"),
        ("11:00", "12:30"),
        ("12:45", "14:15"),
        ("14:30", "16:00"),
        ("16:15", "17:45"),
        ("18:00", "19:30"),
        ("19:45", "21:15"),
    ]

    def _pick_alt_slot(fid: str, day: str, pref: dict) -> tuple[str, str] | None:
        """
        Strict alt-slot picker:

        - If faculty has preferred_times: ONLY use those windows (no grid).
        - If faculty has NO preferred_times at all (even from fallback):
              → return None, meaning this faculty cannot host another section
                for this day via auto-assigned slot.
        """
        wins = pref.get("preferred_times")

        # Normalize to a list
        seq = []
        if isinstance(wins, list):
            seq = wins
        elif wins:
            seq = [wins]

        # No preferred_times at all → no alt slot; do not use GRID
        if not seq:
            print(
                f"DEBUG-ALT-SLOT: fid={fid} day={day} has NO preferred_times; "
                "no alt slot will be proposed."
            )
            return None

        # Try each preferred window in order, skipping those already used
        for w in seq:
            hhmm = _parse_win_to_hhmm_pair(w)
            if not hhmm:
                continue
            b_alt, e_alt = hhmm
            if not _would_reuse(fid, day, b_alt, e_alt):
                print(
                    f"DEBUG-ALT-SLOT: fid={fid} day={day} "
                    f"picked preferred window {b_alt}-{e_alt}"
                )
                return (b_alt, e_alt)

        # All preferred windows are exhausted / taken
        print(
            f"DEBUG-ALT-SLOT: fid={fid} day={day} has preferred_times but "
            "all are exhausted or conflicting → no alt slot."
        )
        return None

    
    # Seed current used slots from table rows
    for r in rows:
        fid = r.get("faculty_id") or None
        _add_used(fid, r.get("day1"), r.get("begin1"), r.get("end1"))
        _add_used(fid, r.get("day2"), r.get("begin2"), r.get("end2"))

    sugg = await compute_load_recommendations(
        term_id=term_id,
        db=db,
        department_id=department_id,
        protected_section_ids=locked_section_ids,
        source_rows=rows,
    )
    debug = sugg.get("debug", {}) or {}
    phase7_no_time = (debug.get("phase7_no_time_details") or {}) if isinstance(debug, dict) else {}

    if not sugg.get("assignments"):
        return {
            "term": _term_label(active),
            "term_id": term_id,
            "rows": rows,
            "debug": {
                "course_order_len": len(sugg.get("courses_order", [])),
                "assignments_len": 0,
                **debug,
                **prefs_debug,
                "candidate_sizes": {
                    cid: len(info.get("candidates", []))
                    for cid, info in (sugg.get("by_course", {}) or {}).items()
                },
            },
        }

    suggestions = {s["section_id"]: s for s in sugg.get("assignments", [])}

    overlay_reasons: dict[str, dict] = {}
    for r in rows:
        sid = r.get("id")
        if not sid:
            continue

        # ---------- NEW: preserve locked/manual rows ----------
        if sid in locked_section_ids:
            overlay_reasons.setdefault(sid, {}).setdefault(
                "locked",
                "Row already has manual faculty + schedule; auto-assign skipped."
            )
            # Do NOT touch faculty, days, or times for this row
            continue
        # ------------------------------------------------------

        a = suggestions.get(sid)


        if not a:
            # If Phase 7 explicitly failed to find a slot for this section,
            # clear faculty so UI shows it as unassigned, and mark a note.
            info = phase7_no_time.get(sid) or {}
            if info.get("reason") == "no_free_slot_from_pool":
                # we know there was a faculty_id in Phase 7 (info["faculty_id"])
                r["faculty"] = ""
                r["faculty_id"] = ""

                for k in ("day1","begin1","end1","day2","begin2","end2","room1","room2"):
                    r[k] = ""

                # mark as unassigned but with a conflict note so it's traceable
                r["status"] = "Unassigned"
                r["conflictNote"] = (
                    "Auto-assign removed previous faculty: no compatible " 
                    "time slot found (preferences / 4.5h rule)."
                )

            # nothing else to overlay for this row
            continue

        fid = a.get("faculty_id")
        d1, b1, e1 = a.get("day1"), a.get("begin1"), a.get("end1")
        d2, b2, e2 = a.get("day2"), a.get("begin2"), a.get("end2")
        why: dict[str, str] = {}

        # Avoid duplicate slots, try alt from prefs if needed
        if _would_reuse(fid, d1, b1, e1):
            alt = _pick_alt_slot(fid, (d1 or "").upper(), fac_prefs.get(fid, {}))
            if alt:
                b1, e1 = alt
                why["slot1"] = "picked_alt_pref_window"
            else:
                d1 = b1 = e1 = None
                why["slot1"] = "duplicate_slot_removed"

        if _would_reuse(fid, d2, b2, e2):
            alt = _pick_alt_slot(fid, (d2 or "").upper(), fac_prefs.get(fid, {}))
            if alt:
                b2, e2 = alt
                why["slot2"] = "picked_alt_pref_window"
            else:
                d2 = b2 = e2 = None
                why["slot2"] = "duplicate_slot_removed"

        old_pair = (d1, d2)
        d1, b1, e1, d2, b2, e2 = _normalize_pair_order(d1, b1, e1, d2, b2, e2)
        if old_pair != (d1, d2):
            why["pairing"] = f"normalized_from_{old_pair}_to_{(d1, d2)}"

        # --- Write faculty label for the row (but we may clear it later if no slots) ---
        r["faculty"] = a.get("faculty", r["faculty"])
        # Also ensure faculty_id is mirrored from suggestion if missing
        if fid and not r.get("faculty_id"):
            r["faculty_id"] = fid

        # --- Apply final slots to the row ---
        if d1 and b1 and e1:
            r["day1"], r["begin1"], r["end1"] = d1, b1, e1
            _add_used(fid, d1, b1, e1)
        else:
            why.setdefault("slot1", "left_blank")

        if d2 and b2 and e2:
            r["day2"], r["begin2"], r["end2"] = d2, b2, e2
            _add_used(fid, d2, b2, e2)
        else:
            why.setdefault("slot2", "left_blank")


        # --- GOAL 2: if faculty has NO valid slots left for this section, drop assignment ---
        if not (r.get("day1") or r.get("day2")) and fid:
            # Clear faculty + schedule so this section is truly unassigned
            print(
                f"[GOAL2] Dropping faculty {fid} from section {r.get('id') or r.get('section_id')} "
                "because no valid non-conflicting preferred slots could be assigned."
            )
            r["faculty"] = ""
            r["faculty_id"] = ""
            r["mode"] = r.get("mode")  # keep mode as-is or blank if you prefer
            r["status"] = "Unassigned"
            # wipe any stale times just in case
            for key in ("day1","begin1","end1","day2","begin2","end2"):
                r[key] = ""
            why["dropped_faculty_goal2"] = "no_valid_slots_available_after_overlay"

        # --- ensure mode follows the chosen assignment/faculty preference ---
        suggested_mode = (a.get("mode") or "").strip().upper()
        if suggested_mode:
            r["mode"] = suggested_mode
        elif not (r.get("mode") or "").strip():
            sid = r.get("id") or r.get("section_id")
            crt = (sid_to_crt.get(sid) or "").strip().upper()  # course room type
            fac_mode = (fac_pref_mode.get(fid) or "").strip().upper() if fid else ""
            if fac_mode:
                r["mode"] = fac_mode
            else:
                if crt == "ONLINE":
                    r["mode"] = "FOL"
                else:
                    r["mode"] = "HYB"

        # --- derive rooms from row-level mode + campus (only if blank) ---
        def _derive_rooms_from_mode_row(row: dict) -> tuple[str, str]:
            mode = (row.get("mode") or "").strip().upper()
            if not mode:
                return (row.get("room1") or "", row.get("room2") or "")
            sid = row.get("id") or row.get("section_id")
            campus = (sid_to_campus.get(sid) or "").upper()
            crt = sid_to_crt.get(sid) or ""  # course room type

            if mode == "FOL":
                return ("Online", "Online")

            if mode == "HYB":
                if campus == "CMPS0001":
                    return ("Online", crt or "TBA")
                if campus == "CMPS0002":
                    return (crt or "TBA", "Online")
                return (row.get("room1") or "", row.get("room2") or "")

            return (row.get("room1") or "", row.get("room2") or "")

        # Only fill when currently blank (don’t stomp explicit suggestions)
        if not (r.get("room1") or "").strip() or not (r.get("room2") or "").strip():
            dr1, dr2 = _derive_rooms_from_mode_row(r)
            if not (r.get("room1") or "").strip():
                r["room1"] = dr1
            if not (r.get("room2") or "").strip():
                r["room2"] = dr2

        # Status / conflict overlay
        # NOTE: incoming rows may include an empty string status ("") which should
        # NOT overwrite the computed/default status. Treat blank as "not provided".
        incoming_status = (a.get("status") or "").strip()
        if incoming_status:
            r["status"] = incoming_status
        else:
            r["status"] = r.get("status") or "Pending"
        if a.get("conflictNote"):
            r["conflictNote"] = a["conflictNote"]

        # cosmetic: rows with proposed times but no faculty shouldn’t show "Unassigned"
        if not r.get("faculty") and (r.get("day1") or r.get("day2")):
            if r.get("status", "").lower() == "unassigned":
                r["status"] = "Pending"

        overlay_reasons[r["id"]] = {
            "faculty_id": fid,
            "input_from_phase7": {
                "day1": a.get("day1"), "begin1": a.get("begin1"), "end1": a.get("end1"),
                "day2": a.get("day2"), "begin2": a.get("begin2"), "end2": a.get("end2"),
            },
            "result_after_overlay": {
                "day1": r.get("day1"), "begin1": r.get("begin1"), "end1": r.get("end1"),
                "day2": r.get("day2"), "begin2": r.get("begin2"), "end2": r.get("end2"),
            },
            "reason": why,
        }

    _flag_faculty_conflicts(rows, resolve_conflicts=True)

    # --- NEW: faculty-level hard conflict detection (any overlapping slots) ---
    # Gather all (faculty, day, time-window, section_id) from final rows
    fac_day_windows: dict[str, dict[str, list[tuple[int, int, str]]]] = {}

    for r in rows:
        fid = (r.get("faculty_id") or "").strip()
        if not fid:
            continue

        for which in ("1", "2"):
            day = (r.get(f"day{which}") or "").strip()
            b = (r.get(f"begin{which}") or "").strip()
            e = (r.get(f"end{which}") or "").strip()
            if not (day and b and e):
                continue

            st = _to_min(b)
            en = _to_min(e)
            if st is None or en is None or en <= st:
                continue

            sid = str(r.get("id") or r.get("section_id") or "")
            if not sid:
                continue

            fac_day_windows.setdefault(fid, {}).setdefault(day, []).append((st, en, sid))

    # For each faculty/day, detect overlapping windows and flag both sections
    hard_conflicts: dict[str, dict[str, list[tuple[str, str]]]] = {}

    for fid, day_map in fac_day_windows.items():
        for day, slots in day_map.items():
            # sort by start time
            slots.sort(key=lambda x: x[0])  # (st, en, sid)
            prev_st = prev_en = None
            prev_sid: str | None = None

            for st, en, sid in slots:
                if prev_st is not None and st < prev_en:
                    # overlap between prev_sid and sid
                    hard_conflicts.setdefault(fid, {}).setdefault(day, []).append((prev_sid, sid))
                # keep the "outermost" interval as reference
                if prev_en is None or en > prev_en:
                    prev_st, prev_en, prev_sid = st, en, sid

    # Apply flags to the rows and optionally drop weaker assignments
    def _row_conflict_priority(row: dict, sid: str) -> tuple[int, int]:
        """
        Lower tuple = stronger (we prefer to KEEP).
        (course_tier, status_score)

        - course_tier: Foundation (0) < Major (1) < SHS (2) < other (3)
        - status_score: Confirmed (0) < Pending (1) < others (2)
        """
        tier = _course_tier_for_sid(sid)
        status = (row.get("status") or "").lower()
        if status == "confirmed":
            status_score = 0
        elif status == "pending":
            status_score = 1
        else:
            status_score = 2
        return (tier, status_score)

    for fid, day_map in hard_conflicts.items():
        for day, pairs in day_map.items():
            for sid1, sid2 in pairs:
                r1 = rows_by_id.get(str(sid1))
                r2 = rows_by_id.get(str(sid2))

                # Both rows must exist AND belong to this faculty
                if not r1 or not r2:
                    continue
                if (r1.get("faculty_id") or "").strip() != fid:
                    continue
                if (r2.get("faculty_id") or "").strip() != fid:
                    continue

                # 1) Always flag both rows as conflicting (for transparency)
                for rr, sid in ((r1, str(sid1)), (r2, str(sid2))):
                    if (rr.get("status") or "").lower() != "unassigned":
                        rr["status"] = "Conflict"

                    msg = f"Faculty schedule clash on {day} (overlapping time slot)."
                    existing_note = (rr.get("conflictNote") or "").strip()
                    if msg not in existing_note:
                        rr["conflictNote"] = (existing_note + " " + msg).strip().lstrip()

                # 2) Decide which one to drop based on course tier + status
                p1 = _row_conflict_priority(r1, str(sid1))
                p2 = _row_conflict_priority(r2, str(sid2))

                # smaller tuple is stronger → we KEEP that one
                if p1 <= p2:
                    stronger_row, weaker_row = r1, r2
                    weaker_sid = str(sid2)
                else:
                    stronger_row, weaker_row = r2, r1
                    weaker_sid = str(sid1)

                # If weaker_row is already unassigned, nothing to drop
                if (weaker_row.get("faculty_id") or "").strip() == "":
                    continue

                # Unassign weaker row: this removes the double-booking
                weaker_row["faculty_id"] = ""
                weaker_row["faculty"] = ""
                weaker_row["status"] = "Unassigned"

                for k in ("day1","begin1","end1","day2","begin2","end2","room1","room2"):
                    weaker_row[k] = ""

                extra_msg = (
                    " Auto-assign dropped this faculty from this section due to a "
                    "schedule clash with a higher-priority class."
                )
                existing_note = (weaker_row.get("conflictNote") or "").strip()
                if extra_msg not in existing_note:
                    weaker_row["conflictNote"] = (existing_note + " " + extra_msg).strip().lstrip()

    # --- NEW: conservative SHS refill after conflicts (low-risk) ---
    def _shs_refill_after_conflicts():
        """
        After all phases + conflict flags, try to use remaining capacity to
        fill UNASSIGNED SHS sections with compatible, underloaded faculty.

        This does NOT touch non-SHS sections and does NOT move anyone;
        it only fills blanks if:
          - faculty has remaining units (preferred_units cap),
          - SHS fixed schedule does not clash,
          - streak rule is still respected.
        """
        courses = ctx_for_prefs.courses or {}
        by_course = (sugg.get("by_course") or {}) if isinstance(sugg, dict) else {}

        # 1) Recompute current units from final rows
        current_units: dict[str, int] = {}
        for r in rows:
            fid = (r.get("faculty_id") or "").strip()
            if not fid:
                continue
            try:
                u = int(r.get("units") or 0)
            except (TypeError, ValueError):
                u = 0
            if u > 0:
                current_units[fid] = current_units.get(fid, 0) + u

        # 2) Gather UNASSIGNED SHS rows
        shs_rows: list[dict] = []
        for r in rows:
            sid = r.get("id") or r.get("section_id")
            if not sid:
                continue
            cid = sid_to_course.get(sid)
            if not cid:
                continue
            cinfo = courses.get(cid) or {}
            ctype = str(
                cinfo.get("type") or cinfo.get("type_of_course") or ""
            ).strip().upper()
            if ctype != "SHS":
                continue
            if (r.get("faculty_id") or "").strip():
                continue  # already has a faculty
            shs_rows.append(r)

        if not shs_rows:
            return  # nothing to do

        def _faculty_label(fid: str) -> str:
            # Reuse existing helper + users_by_faculty from phase0_load
            u = (ctx_for_prefs.users_by_faculty or {}).get(fid) or {}
            return _display_name_from_users(u)

        def _slots_for_faculty_day(fid: str, day: str) -> list[tuple[int, int]]:
            """Collect existing [start_min, end_min] slots for this faculty on a given day."""
            intervals: list[tuple[int, int]] = []
            day_key = (day or "").upper().strip()
            if not day_key:
                return intervals

            for rr in rows:
                if (rr.get("faculty_id") or "").strip() != fid:
                    continue
                for ord_s in ("1", "2"):
                    d = (rr.get(f"day{ord_s}") or "").upper().strip()
                    if d != day_key:
                        continue
                    b = rr.get(f"begin{ord_s}") or ""
                    e = rr.get(f"end{ord_s}") or ""
                    st = _to_min(b)
                    en = _to_min(e)
                    if st is None or en is None or en <= st:
                        continue
                    intervals.append((st, en))
            return intervals

        def _slot_ok_for_faculty(fid: str, day: str, b_hhmm: str, e_hhmm: str) -> bool:
            """Check both overlap + 4.5h streak for a candidate slot."""
            st_new = _to_min(b_hhmm)
            en_new = _to_min(e_hhmm)
            if st_new is None or en_new is None or en_new <= st_new:
                return False

            existing = _slots_for_faculty_day(fid, day)

            # Overlap check
            for eb, ee in existing:
                # intervals overlap if not (new ends before old starts OR new starts after old ends)
                if not (en_new <= eb or st_new >= ee):
                    return False

            # Streak rule (reuse your global helper)
            if not _streak_ok_for_day(existing, [(st_new, en_new)]):
                return False

            return True

        # 3) Greedily try to fill SHS blanks using original candidate pools
        for r in shs_rows:
            sid = r.get("id") or r.get("section_id")
            cid = sid_to_course.get(sid)
            try:
                units = int(r.get("units") or 0)
            except (TypeError, ValueError):
                units = 0

            if not cid or units <= 0:
                continue

            course_dbg = by_course.get(cid) or {}
            cand_list = course_dbg.get("candidates") or []
            if not cand_list:
                continue  # no known candidates for this course

            for cand in cand_list:
                fid = (cand.get("faculty_id") or "").strip()
                if not fid:
                    continue

                cap = preferred_units_by_faculty.get(fid)
                if cap is None:
                    continue  # no cap info, skip to be safe

                cur = current_units.get(fid, 0)
                if cur + units > cap:
                    continue  # would overflow their preferred_units

                # SHS uses fixed schedule already in the row
                day1, b1, e1 = r.get("day1"), r.get("begin1"), r.get("end1")
                day2, b2, e2 = r.get("day2"), r.get("begin2"), r.get("end2")

                ok = True
                if day1 and b1 and e1:
                    if not _slot_ok_for_faculty(fid, day1, b1, e1):
                        ok = False
                if ok and day2 and b2 and e2:
                    if not _slot_ok_for_faculty(fid, day2, b2, e2):
                        ok = False

                if not ok:
                    continue

                r["faculty_id"] = fid
                r["faculty"] = _faculty_label(fid)
                if not (r.get("status") or "").strip():
                    r["status"] = "Pending"

                current_units[fid] = cur + units
                # no need to change times; they are fixed on SHS

                # Optional: note in debug for inspection
                overlay_reasons.setdefault(sid, {}).setdefault(
                    "shs_refill", {}
                )["assigned_to"] = fid

                # move to next SHS row
                break

    # Run the conservative SHS refill pass (after conflicts)
    _shs_refill_after_conflicts()

    # --- NEW: pending RFC indicator per SECTION (for red dot in Actions) ---
    # RFCs are keyed by (faculty_id + term_id + section_id). The old implementation only keyed by faculty_id,
    # which caused *all* rows of that faculty to show the red dot even if the RFC was for only one section.
    open_rfc_keys: set[tuple[str, str]] = set()
    try:
        cur = db[COL_LOAD_RFC].find(
            {"term_id": active.get("term_id"), "status": {"$in": ["NEEDS_OM", "open", "OPEN"]}},
            {"_id": 0, "faculty_id": 1, "section_id": 1},
        )
        async for d in cur:
            fid = str(d.get("faculty_id") or "").strip()
            sid = str(d.get("section_id") or "").strip()
            if fid and sid:
                open_rfc_keys.add((fid, sid))
    except Exception:
        open_rfc_keys = set()

    for r in rows:
        fid = str(r.get("faculty_id") or "").strip()
        sid = str(r.get("id") or r.get("section_id") or "").strip()
        # Faculty assignments synced from Faculty Service should be treated as already approved.
        # They should not show RFC notifications in OM Load Assignment.
        if bool(r.get("synced_from_faculty_service")):
            r["pending_rfc"] = False
        else:
            r["pending_rfc"] = bool(fid and sid and (fid, sid) in open_rfc_keys)

    trace_by_section: dict[str, dict] = {}
    try:
        for t in ((debug or {}).get("assignment_trace") or []):
            sid = str(t.get("section_id") or "").strip()
            if sid:
                trace_by_section[sid] = dict(t)
    except Exception:
        trace_by_section = {}

    for r in rows:
        sid = str(r.get("id") or r.get("section_id") or "").strip()
        fid = (r.get("faculty_id") or r.get("facultyId") or "").strip()
        fname = (r.get("faculty") or r.get("facultyName") or "").strip()

        md = trace_by_section.get(sid)
        if md and fid:
            r["assignment_metadata"] = {
                "assigned_faculty": md.get("faculty") or fname or "",
                "assigned_faculty_id": md.get("faculty_id") or fid or "",
                "reason_label": md.get("reason_label") or "",
                "reason_sentence": md.get("reason_sentence") or "",
            }
        else:
            r.pop("assignment_metadata", None)

        if (not fid) or (not fname):
            for k in ("day1", "begin1", "end1", "day2", "begin2", "end2", "room1", "room2"):
                r[k] = ""
            r.pop("assignment_metadata", None)
            if not fid:
                r["status"] = "Unassigned"

    return {
        "term": _term_label(active),
        "term_id": term_id,
        "rows": rows,
        "debug": {**debug, **prefs_debug, "overlay_no_time_details": overlay_reasons},
    }

#    ===========================================================
#    =====================  LOAD RECO ==========================
#    ===========================================================

# ===============  TYPES  ======================
Campus = Literal["Manila", "Laguna", "Online"]
CourseType = Literal["Foundation", "Major", "SHS", "GS"]
Mode = Literal["HYB", "FOL", "ONSITE", "ONLINE"]

@dataclass
class Section:
    section_id: str
    course_id: str
    campus: Campus
    units: int
    schedule: List[Dict[str, Any]]  # [{day:int, start:"HH:MM", end:"HH:MM"}]
    mode: Mode

@dataclass
class CourseStat:
    course_id: str
    type: CourseType
    sections: int
    units: int
    per_campus: Dict[Campus, int]
    score: int

# ===============  MILESTONE A (Phases 0–2)  ===============
@dataclass
class ContextA:
    term_id: str
    sections: list[dict]
    courses: dict[str, dict]
    schedules_by_section: dict[str, list[dict]]
    faculty: list[dict]
    users_by_faculty: dict[str, dict]
    prefs_prev_term_id: str | None
    prefs_by_faculty: dict[str, dict]
    kac_helper: dict | None = None
    course_order: list[str] | None = None

async def phase0_load(term_id: str, db, department_id: str | None = None) -> ContextA:
    # ------------------------------
    # 0) Term-scoped Sections
    # ------------------------------
    # IMPORTANT:
    # We must remain compatible with deployments where *either*:
    #   - sections carry department_id, OR
    #   - courses carry department_id (and sections only reference course_id)
    # A regression here can make the algorithm think there are "no sections" and
    # return an empty assignments set, causing the UI to show a success toast but
    # no auto-filled schedules.

    section_projection = {
        "_id": 0,
        "section_id": 1,
        "course_id": 1,
        "department_id": 1,
        "campus_id": 1,
        "units": 1,
        "mode": 1,
        
        "owner_program_id": 1,
        "owner_batch_id": 1,
        "batch_number": 1,

        "day1": 1,
        "begin1": 1,
        "end1": 1,
        "room1": 1,
        "day2": 1,
        "begin2": 1,
        "end2": 1,
        "room2": 1,
    }

    # A) Prefer filtering by sections.department_id when it exists.
    # If that yields no results, fall back to filtering by courses.department_id.
    sections: list[dict] = []
    section_q: dict[str, Any] = {"term_id": term_id}
    if department_id:
        section_q_dept = {**section_q, "department_id": department_id}
        sections = await db[COL_SECTIONS].find(section_q_dept, section_projection).sort(
            [("course_id", 1), ("section_id", 1)]
        ).to_list(None)

    if not sections:
        # B) Fallback: derive section list from courses in the department.
        course_q: dict[str, Any] = {}
        if department_id:
            course_q["department_id"] = department_id
        course_rows_for_filter = await db[COL_COURSES].find(course_q, {"_id": 0, "course_id": 1}).to_list(None)
        course_ids_for_filter = [c.get("course_id") for c in course_rows_for_filter if c.get("course_id")]
        section_q_fallback = dict(section_q)
        if course_ids_for_filter:
            section_q_fallback["course_id"] = {"$in": course_ids_for_filter}
        elif department_id:
            # If a department filter was requested but we cannot resolve any course ids,
            # do NOT pull the entire term's sections; treat as no sections for this dept.
            section_q_fallback["course_id"] = {"$in": []}

        sections = await db[COL_SECTIONS].find(section_q_fallback, section_projection).sort(
            [("course_id", 1), ("section_id", 1)]
        ).to_list(None)

    # Derive course_ids from sections we actually found.
    course_ids = [s.get("course_id") for s in sections if s.get("course_id")]

    # Early return if no sections
    if not sections:
        return ContextA(
            term_id=term_id,
            sections=[],
            courses={},
            schedules_by_section={},
            faculty=[],
            users_by_faculty={},
            prefs_prev_term_id=term_id,     # kept name for compatibility; equal to term_id
            prefs_by_faculty={},
            kac_helper=None,
            course_order=None,
        )

    # ------------------------------
    # 1) Courses (normalize units & type)
    # ------------------------------
    course_rows = await db[COL_COURSES].find({"course_id": {"$in": course_ids}}, {"_id": 0}).to_list(None)

    def _units(r: dict) -> int:
        v = r.get("units", r.get("units_per_section"))
        try:
            v = int(v)
        except Exception:
            v = 0
        return v if v and v > 0 else 3

    def _ctype(r: dict) -> str:
        t = (r.get("type_of_course") or r.get("type") or "Major")
        return t.strip() if isinstance(t, str) else "Major"

    courses = {
        c["course_id"]: {**c, "units": _units(c), "type": _ctype(c)}
        for c in course_rows
        if c.get("course_id")
    }

    # ------------------------------
    # 2) KACs (Knowledge Area Clusters)
    # ------------------------------
    kac_rows = await db["kacs"].find({}, {"_id": 0}).to_list(None)
    course_to_kacs: dict[str, set[str]] = {}
    for k in kac_rows:
        for cid in (k.get("course_list") or []):
            if cid:
                course_to_kacs.setdefault(cid, set()).add(k["kac_id"])
    ctx_kacs = {k["kac_id"]: k for k in kac_rows if k.get("kac_id")}

    # ------------------------------
    # 3) Schedules (normalized collection)
    # ------------------------------
    section_ids = [s["section_id"] for s in sections if s.get("section_id")]
    schedules_by_section: dict[str, list[dict]] = {}
    if section_ids:
        sched_rows = await db[COL_SCHED].find(
            {"section_id": {"$in": section_ids}},
            {"_id": 0}
        ).to_list(None)
        for s in sched_rows:
            sid = s.get("section_id")
            if sid:
                schedules_by_section.setdefault(sid, []).append(s)

    # 3b) Campus-level blocked windows (for now we care about CMPS0002)
    campus_blocked: dict[str, dict[int, list[tuple[int, int]]]] = {}
    for s in sections:
        sid = s.get("section_id")
        campus = (s.get("campus_id") or "").strip().upper()
        if not sid or not campus:
            continue
        slots = _slots_from_scheds(schedules_by_section.get(sid, []))
        if not slots:
            continue
        # Store all CMPS0002 schedules as blocked windows
        if campus == "CMPS0002":
            for di, itv in slots:
                campus_blocked.setdefault(campus, {}).setdefault(di, []).append(itv)

    # Coalesce per day for faster checks later
    for camp, days in campus_blocked.items():
        for di, arr in days.items():
            arr.sort()
            merged: list[tuple[int, int]] = []
            for st, en in arr:
                if not merged or merged[-1][1] <= st:
                    merged.append((st, en))
                else:
                    last_st, last_en = merged[-1]
                    merged[-1] = (last_st, max(last_en, en))
            days[di] = merged

    # ------------------------------
    # 4) Faculty & Names (bulk user lookup; filter archived)
    # ------------------------------
    f_query = {"is_archived": {"$ne": True}}
    if department_id:
        # Apply if your faculty docs carry department_id; safe to keep even if not present
        f_query["department_id"] = department_id

    faculty = await db[COL_FACULTY].find(
        f_query,
        {
            "_id": 0,
            "faculty_id": 1,
            "user_id": 1,
            "employment_type": 1,
            "remaining_units": 1,
            "qualified_kacs": 1,
            "kac_ids": 1,
            "certifications": 1,
        },
    ).to_list(None)

    # Bulk resolve names to avoid N+1
    user_ids = [f.get("user_id") for f in faculty if f.get("user_id")]
    users_by_id: dict[str, dict] = {}
    if user_ids:
        user_docs = await db[COL_USERS].find(
            {"user_id": {"$in": user_ids}},
            {"_id": 0, "user_id": 1, "first_name": 1, "last_name": 1},
        ).to_list(None)
        users_by_id = {u["user_id"]: u for u in user_docs if u.get("user_id")}

    users_by_faculty: dict[str, dict] = {}
    for f in faculty:
        fid = f.get("faculty_id")
        if not fid:
            continue
        u = users_by_id.get(f.get("user_id") or "")
        users_by_faculty[fid] = (u or {})

    # ------------------------------
    # 5) Preferences (for THIS upcoming term_id)
    # ------------------------------
    pref_rows = await db[COL_PREFERENCES].find(
        {"term_id": term_id, "is_finished": True},
        {
            "_id": 0,
            "faculty_id": 1,
            "preferred_units": 1,
            "availability_days": 1,
            "preferred_times": 1,
            "preferred_kacs": 1,
            "campus_id": 1,
            "leave_data": 1,
            "mode": 1,
        },
    ).to_list(None)
    prefs_by_faculty = {
        r["faculty_id"]: r for r in pref_rows if r.get("faculty_id")
    }

    # # --- DEBUG: Print final faculty preferences (after applying fallback logic) ---
    # print("DEBUG-PREF-SUMMARY: ============================")
    # for fid, pref in prefs_by_faculty.items():
    #     days = pref.get("availability_days") or []
    #     times_raw = pref.get("preferred_times") or []
        
    #     # Normalize time windows to HH:MM-HH:MM for clean debugging
    #     times_norm = []
    #     for w in times_raw:
    #         hhmm = None
    #         if isinstance(w, dict):
    #             hhmm = (_mm_to_hhmm(_to_min(w.get("start") or w.get("begin"))),
    #                     _mm_to_hhmm(_to_min(w.get("end") or w.get("finish"))))
    #         elif isinstance(w, (list, tuple)) and len(w) == 2:
    #             hhmm = (_mm_to_hhmm(_to_min(w[0])),
    #                     _mm_to_hhmm(_to_min(w[1])))
    #         elif isinstance(w, str) and "-" in w:
    #             s = w.replace("–", "-").replace("—", "-")
    #             a, b = s.split("-", 1)
    #             hhmm = (_mm_to_hhmm(_to_min(a)), _mm_to_hhmm(_to_min(b)))

    #         if hhmm and hhmm[0] and hhmm[1]:
    #             times_norm.append(f"{hhmm[0]}-{hhmm[1]}")
        
    #     print(
    #         f"DEBUG-PREF-SUMMARY: Faculty {fid} "
    #         f"days={days} | windows={times_norm}"
    #     )
    # print("DEBUG-PREF-SUMMARY: ============================")

    # after prefs_by_faculty (DEBUG)
    debug_pref_windows = {}
    for fid, p in prefs_by_faculty.items():
        times = p.get("preferred_times")
        ok = 0; bad = 0
        seq = times if isinstance(times, list) else ([times] if times else [])
        for t in seq:
            pair = None
            if isinstance(t, dict):
                pair = (_to_min(t.get("start") or t.get("begin")), _to_min(t.get("end") or t.get("finish")))
            elif isinstance(t, (list, tuple)) and len(t) == 2:
                pair = (_to_min(t[0]), _to_min(t[1]))
            elif isinstance(t, str) and "-" in t:
                a, b = t.replace("–","-").replace("—","-").split("-", 1)
                pair = (_to_min(a), _to_min(b))
            if pair and pair[0] >= 0 and pair[1] > pair[0]:
                ok += 1
            else:
                bad += 1
        if ok + bad:
            debug_pref_windows[fid] = {"ok_windows": ok, "bad_windows": bad}

    # Keep historical field name but set to current term (since 'target = next' is already satisfied)
    prefs_prev_term_id = term_id


    all_terms = await db[COL_TERMS].find(
        {}, {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1}
    ).sort([("acad_year_start", 1), ("term_number", 1)]).to_list(None)    

    # ------------------------------
    # 7) Leaves
    # ------------------------------
    # 7) Leaves
    term_rank = {t["term_id"]: i for i, t in enumerate(all_terms or [])}

    # --- NEW: Fallback preferences from previous terms ---
    # If a faculty has no prefs for this upcoming term, reuse their most recent
    # finished preference record from any past term (if it exists).
    faculty_ids_all = [
        f["faculty_id"] for f in (faculty or []) if f.get("faculty_id")
    ]
    missing_pref_fids = set(faculty_ids_all) - set((prefs_by_faculty or {}).keys())

    if missing_pref_fids:
        fallback_rows = await db[COL_PREFERENCES].find(
            {
                "faculty_id": {"$in": list(missing_pref_fids)},
                "is_finished": True,
            },
            {
                "_id": 0,
                "faculty_id": 1,
                "preferred_units": 1,
                "availability_days": 1,
                "preferred_times": 1,
                "preferred_kacs": 1,
                "campus_id": 1,
                "leave_data": 1,
                "mode": 1,
                "term_id": 1,
            },
        ).to_list(None)

        latest_by_fac: dict[str, dict] = {}
        for row in fallback_rows:
            fid = row.get("faculty_id")
            t_id = row.get("term_id")
            if not fid or not t_id:
                continue

            prev = latest_by_fac.get(fid)
            if not prev:
                latest_by_fac[fid] = row
                continue

            prev_rank = term_rank.get(prev.get("term_id"), -1)
            cur_rank = term_rank.get(t_id, -1)
            if cur_rank > prev_rank:
                latest_by_fac[fid] = row

        for fid, prow in latest_by_fac.items():
            if fid not in prefs_by_faculty:
                prefs_by_faculty[fid] = prow
                # print(
                #     f"DEBUG-PREF-FALLBACK: using previous-term preferences for "
                #     f"faculty {fid} from term {prow.get('term_id')}"
                # )


    # Case-insensitive "approved" + only the fields we need
    leave_rows = await db[COL_LEAVES].find(
        {"approval_status": {"$regex": r"^approved$", "$options": "i"}},
        {"_id": 0, "faculty_id": 1, "start_term_id": 1, "end_term_id": 1}
    ).to_list(None)

    blocked = set()
    cur_rank = term_rank.get(term_id, None)
    if cur_rank is not None:
        for lv in leave_rows or []:
            fid = lv.get("faculty_id")
            st  = lv.get("start_term_id")
            et  = lv.get("end_term_id")
            if not fid:
                continue
            st_r = term_rank.get(st) if st else None
            et_r = term_rank.get(et) if et else None

            # start..∞
            if st_r is not None and et_r is None and cur_rank >= st_r:
                blocked.add(fid); continue
            # -∞..end
            if st_r is None and et_r is not None and cur_rank <= et_r:
                blocked.add(fid); continue
            # bounded [st..et]
            if st_r is not None and et_r is not None and st_r <= cur_rank <= et_r:
                blocked.add(fid)

    # Fallback: also respect prefs.leave_data (union into blocked)
    for fid, pref in (prefs_by_faculty or {}).items():
        ld = pref.get("leave_data") or {}
        st = ld.get("start_term_id"); et = ld.get("end_term_id")
        st_r = term_rank.get(st) if st else None
        et_r = term_rank.get(et) if et else None
        if cur_rank is None:
            continue
        if st_r is not None and et_r is None and cur_rank >= st_r:
            blocked.add(fid); continue
        if st_r is None and et_r is not None and cur_rank <= et_r:
            blocked.add(fid); continue
        if st_r is not None and et_r is not None and st_r <= cur_rank <= et_r:
            blocked.add(fid)

    # ------------------------------
    # NEW: Existing faculty assignments for THIS term
    # ------------------------------
    asg_rows = await db[COL_ASSIGN].find(
        {"term_id": term_id, "is_archived": {"$ne": True}},
        {"_id": 0, "faculty_id": 1, "section_id": 1}
    ).to_list(None)

    # Build section -> units
    section_to_units: dict[str, int] = {}
    for s in sections:
        sid = s.get("section_id")
        cid = s.get("course_id")
        if not sid or not cid:
            continue
        units = int((courses.get(cid) or {}).get("units") or 0)
        section_to_units[sid] = units

    # Sum current assigned units per faculty
    current_assigned_units = defaultdict(int)
    for a in asg_rows or []:
        fid = a.get("faculty_id")
        sid = a.get("section_id")
        if not fid or not sid:
            continue
        u = section_to_units.get(sid, 0)
        current_assigned_units[fid] += u

    # ------------------------------
    # 8) Assemble Context
    # ------------------------------
    ctx = ContextA(
        term_id=term_id,
        sections=sections,
        courses=courses,
        schedules_by_section=schedules_by_section,
        faculty=faculty,
        users_by_faculty=users_by_faculty,
        prefs_prev_term_id=prefs_prev_term_id,   # kept for compatibility
        prefs_by_faculty=prefs_by_faculty,
        kac_helper=None,
        course_order=None,
    )
    # Attach extras (attrs referenced by later phases)
    ctx.kacs = ctx_kacs                          # type: ignore[attr-defined]
    ctx.course_to_kacs = course_to_kacs          # type: ignore[attr-defined]
    ctx.leave_blocked = blocked
    ctx.pref_windows_quality = debug_pref_windows  # type: ignore[attr-defined]
    ctx.campus_blocked = campus_blocked
    ctx.current_assigned_units = current_assigned_units
    print("phase0_load → leave_rows:", len(leave_rows), "blocked:", len(blocked), "has FAC0002:", "FAC0002" in blocked)  # debug
    
    # Build exclusion sets
    all_fids = {f["faculty_id"] for f in ctx.faculty}
    no_pref_fids = all_fids - set((ctx.prefs_by_faculty or {}).keys())
    blocked_fids = set(ctx.leave_blocked or set())

    # Final eligible faculty = has prefs AND not on leave
    eligible = [f for f in ctx.faculty
                if f["faculty_id"] not in no_pref_fids
                and f["faculty_id"] not in blocked_fids]

    # ------------------------------
    # 6) Teaching history — optimized (join faculty_assignments.section_id -> sections.section_id)
    #     • Count history for all non-null historical faculty assignments on courses that appear this term.
    #     • Do NOT rely on faculty_assignments.term_id; historical lineage is resolved from sections.term_id.
    # ------------------------------
    candidate_cids = sorted({s["course_id"] for s in (ctx.sections or []) if s.get("course_id")})

    history_map: dict[tuple[str, str], int] = {}
    hist_by_course: dict[str, int] = {}

    if candidate_cids:
        # 1) Fetch all historical assignments with a real faculty and section id.
        asg_rows = await db[COL_ASSIGN].find(
            {
                "faculty_id": {"$nin": [None, ""]},
                "section_id": {"$nin": [None, ""]},
            },
            {"_id": 0, "faculty_id": 1, "section_id": 1, "created_at": 1},
        ).to_list(None)

        # 2) Join to sections to recover course_id (and historical term when needed elsewhere).
        section_ids = sorted({str(r.get("section_id")) for r in (asg_rows or []) if r.get("section_id")})
        if section_ids:
            sec_rows = await db[COL_SECTIONS].find(
                {"section_id": {"$in": section_ids}},
                {"_id": 0, "section_id": 1, "course_id": 1, "term_id": 1},
            ).to_list(None)
            sec_to_course = {
                str(s["section_id"]): str(s.get("course_id") or "")
                for s in (sec_rows or [])
                if s.get("section_id") and s.get("course_id")
            }

            # 3) Tally counts only for current-run candidate courses.
            for r in (asg_rows or []):
                fid = str(r.get("faculty_id") or "").strip()
                sid = str(r.get("section_id") or "").strip()
                cid = sec_to_course.get(sid, "")
                if not fid or not cid or cid not in candidate_cids:
                    continue
                history_map[(fid, cid)] = history_map.get((fid, cid), 0) + 1
                hist_by_course[cid] = hist_by_course.get(cid, 0) + 1

    # 4) attach to context (consumed by Phases 3–5 and 6A)
    ctx.history_map = history_map          # type: ignore[attr-defined]
    ctx.hist_by_course = hist_by_course    # type: ignore[attr-defined]

    # DEBUG: show history gathered for one course
    target_cid = "CRS0020"

    course_total = hist_by_course.get(target_cid, 0)
    per_faculty = sorted(
        [
            (fid, cnt)
            for (fid, cid), cnt in history_map.items()
            if cid == target_cid
        ],
        key=lambda x: (-x[1], x[0])
    )

    print(f"[HISTORY DEBUG] course={target_cid} total_history_rows={course_total}")
    print(f"[HISTORY DEBUG] per_faculty={per_faculty}")
       
    # Attach for debugging/visibility
    ctx.excluded_no_prefs = no_pref_fids
    ctx.excluded_leave = blocked_fids

    # Replace the pool used by downstream phases (B/6A/6B)
    ctx.faculty = eligible

    # --- NEW: GE @ CMPS0002 windows (OWNER-scoped) ---
    campus_blocked: dict[str, dict[tuple[str | None, str | None], dict[int, list[tuple[int, int, str, str, str]]]]] = {}

    day_to_idx = {
        "M": 1, "MON": 1, "MONDAY": 1,
        "T": 2, "TUE": 2, "TUES": 2, "TUESDAY": 2,
        "W": 3, "WED": 3, "WEDNESDAY": 3,
        "H": 4, "TH": 4, "THU": 4, "THUR": 4, "THURS": 4, "THURSDAY": 4,
        "F": 5, "FRI": 5, "FRIDAY": 5,
        "S": 6, "SAT": 6, "SATURDAY": 6,
    }

    sections0 = ctx.sections or []
    courses0 = ctx.courses or {}
    sched_by_sec0 = ctx.schedules_by_section or {}

    for sec in sections0:
        sid = sec.get("section_id")
        if not sid:
            continue

        campus_id0 = str(sec.get("campus_id") or "").strip().upper()
        if campus_id0 != "CMPS0002":
            continue

        cid = (sec.get("course_id") or "").strip()
        if not cid:
            continue

        cinfo = courses0.get(cid) or {}
        ctype = str(cinfo.get("type_of_course") or cinfo.get("type") or "").strip().upper()
        if ctype != "GE":
            continue

        owner_key = (
            (sec.get("owner_program_id") or None),
            (sec.get("owner_batch_id") or None),
        )

        sec_code = sec.get("section_code") or sec.get("section") or ""

        for sch in sched_by_sec0.get(sid, []):
            d = (sch.get("day") or "").strip().upper()
            if d not in day_to_idx:
                continue

            st = _to_min(sch.get("begin_time") or sch.get("start_time"))
            en = _to_min(sch.get("end_time"))
            if st is None or en is None or en <= st:
                continue

            di = day_to_idx[d]
            campus_blocked.setdefault("CMPS0002", {}).setdefault(owner_key, {}).setdefault(di, []).append(
                (st, en, sid, cid, sec_code)
            )

    ctx.campus_blocked = campus_blocked

    print("[phase0] faculty:", len(all_fids),
        "eligible:", len(eligible),
        "no_prefs:", len(no_pref_fids),
        "on_leave:", len(blocked_fids))
        
    return ctx

def phase1_kac_helpers(ctx: ContextA, weights: dict[str, int] | None = None) -> None:
    if weights is None:
        weights = {"Foundation": 3, "Major": 1, "SHS": 1, "GS": 1}
    # minimal KAC-like stats (course-level)
    helper = {
        "total_sections": 0,
        "total_units": 0,
        "by_type": {"Foundation": 0, "Major": 0, "SHS": 0, "GS": 0},
        "course_stats": {},  # course_id -> {type, sections, units, score}
        "priority_score": 0,
    }
    for s in ctx.sections:
        helper["total_sections"] += 1
        c = ctx.courses.get(s["course_id"], {})
        units = int(c.get("units") or 3)
        helper["total_units"] += units
        ctype = c.get("type_of_course") or "Major"
        helper["by_type"][ctype] = helper["by_type"].get(ctype, 0) + 1
        stat = helper["course_stats"].setdefault(
            s["course_id"], {"type": ctype, "sections": 0, "units": 0, "score": 0}
        )
        stat["sections"] += 1
        stat["units"] += units
        stat["score"] += weights.get(ctype, 0)
        helper["priority_score"] += weights.get(ctype, 0)
    ctx.kac_helper = helper

def phase2_course_prioritization(ctx: ContextA, kac_priority_order: list[str] | None = None) -> None:
    stats = ctx.kac_helper["course_stats"]
    if kac_priority_order:
        explicit = [cid for cid in kac_priority_order if cid in stats]
        rest = [cid for cid in stats.keys() if cid not in kac_priority_order]
        rest.sort(key=lambda cid: (stats[cid]["score"], stats[cid]["sections"]), reverse=True)
        ctx.course_order = explicit + rest
    else:
        ctx.course_order = sorted(stats.keys(), key=lambda cid: (stats[cid]["score"], stats[cid]["sections"]), reverse=True)

def phase3_kac_prioritization(ctx: ContextA, weights: dict[str, int] | None = None) -> None:
    """
    Build a KAC-first view of demand, then produce a KAC-aware course order.
    - Score each KAC by the sum of (course_type weight * sections) of its member courses
    - Within each KAC, order courses by the same Phase-2 (score, sections) rule
    Produces:
      ctx.kac_order: [kac_id, ...]
      ctx.course_order: [course_id, ...] respecting KAC order
      ctx.kac_debug: details for debug
    """
    if weights is None:
        weights = {"Foundation": 3, "Major": 1, "SHS": 1, "GS": 1}

    # 1) Per-course stats you already computed in phase1
    cstats = (ctx.kac_helper or {}).get("course_stats", {})

    # 2) Aggregate to KACs
    kac_stats: dict[str, dict] = {}   # kac_id -> {score, sections, units, courses:[...]}
    for cid, st in cstats.items():
        # if a course has no KAC, we drop it into a pseudo bucket "_UNK"
        kset = (getattr(ctx, "course_to_kacs", {}) or {}).get(cid) or {"_UNK"}
        for kid in kset:
            ks = kac_stats.setdefault(kid, {"score": 0, "sections": 0, "units": 0, "courses": []})
            # score contribution = weight(type) * sections (or st['score'] if you prefer)
            w = weights.get(st["type"], 0)
            ks["score"]    += w * int(st["sections"] or 0)
            ks["sections"] += int(st["sections"] or 0)
            ks["units"]    += int(st["units"] or 0)
            ks["courses"].append(cid)

    # 3) Order KACs by (score desc, sections desc, kac_id)
    kac_order = sorted(kac_stats.keys(),
                       key=lambda k: (kac_stats[k]["score"], kac_stats[k]["sections"], k),
                       reverse=True)

    # 4) Within each KAC, order its courses the same way Phase-2 does
    def _course_key(cid: str):
        st = cstats[cid]
        hist = getattr(ctx, "hist_by_course", {}).get(cid, 0)
        # weigh by current demand proxy first, then history as tie-breaker
        return (st["score"], st["sections"], hist)


    course_order: list[str] = []
    seen: set[str] = set()
    for kid in kac_order:
        bucket = list({c for c in kac_stats[kid]["courses"] if c in cstats})
        bucket.sort(key=_course_key, reverse=True)
        for cid in bucket:
            if cid not in seen:
                seen.add(cid)
                course_order.append(cid)

    # 5) Some courses might have no KAC mapping; append them at the end
    for cid in cstats.keys():
        if cid not in seen:
            course_order.append(cid)

    # 6) Attach to context for downstream phases and debugging
    ctx.kac_order = kac_order                             # type: ignore[attr-defined]
    ctx.kac_stats = kac_stats                             # type: ignore[attr-defined]
    ctx.course_order = course_order

async def run_milestone_a(term_id: str, db, department_id: str | None = None) -> dict:
    ctx = await phase0_load(term_id, db, department_id)
    phase1_kac_helpers(ctx)
    phase2_course_prioritization(ctx)
    # return a minimal, inspectable payload (no assignments yet)
    return {
        "term_id": term_id,
        "kac_helper": ctx.kac_helper,
        "course_order": ctx.course_order,
        "counts": {
            "sections": len(ctx.sections),
            "courses": len(ctx.courses),
            "faculty": len(ctx.faculty),
            "prefs": len(ctx.prefs_by_faculty),
        },
    }
# =============  END MILESTONE A  =============

# =============  MILESTONE B (Phases 3–4 only; no assignments)  =============
DEFAULT_UNITS = 9  # fallback capacity when nothing else is available

def _display_name_from_users(u: dict) -> str:
    ln = (u or {}).get("last_name") or ""
    fn = (u or {}).get("first_name") or ""
    return f"{ln}, {fn}".strip(", ").strip()

def _faculty_capacities(ctx: ContextA) -> dict[str, int]:
    """
    Per-faculty hard cap in UNITS, based purely on faculty_preferences
    (preferred_units/load_units) for this term, minus whatever is already
    assigned in current_assigned_units.
    """
    caps: dict[str, int] = {}

    # units already committed for this term (from approved / saved rows)
    existing = getattr(ctx, "current_assigned_units", {}) or {}
    prefs   = getattr(ctx, "prefs_by_faculty", {}) or {}

    for f in ctx.faculty:
        fid = f["faculty_id"]

        pdoc = prefs.get(fid) or {}
        # 1) main source: preferred_units from faculty_preferences
        # 2) fallback: load_units (if you ever use it)
        # 3) fallback: DEFAULT_UNITS (e.g. 9 or 12)
        preferred = int(
            pdoc.get("preferred_units")
            or pdoc.get("load_units")
            or 0
        )

        base_cap = preferred or DEFAULT_UNITS  # ignore faculty_profiles.remaining_units

        already = int(existing.get(fid, 0))
        remaining = max(base_cap - already, 0)

        caps[fid] = remaining

    # DEBUG: so you can see exactly what’s happening when caps become 0
    print("[CAP_ENFORCE_CAPS] preferred_units_by_faculty = {",
          ", ".join(f"{fid}: { (prefs.get(fid) or {}).get('preferred_units') }"
                    for fid in caps.keys()),
          "}")
    print("[CAP_ENFORCE_CAPS] existing_assigned_units =", existing)
    print("[CAP_ENFORCE_CAPS] remaining_caps =", caps)

    return caps

def _enforce_global_caps(ctx: ContextA, assignments: list[dict]) -> tuple[list[dict], dict[str, int]]:
    """
    Walk assignments in order and keep only those that still fit within each faculty's
    remaining capacity. Anything beyond the faculty's cap is dropped.
    Returns (kept_assignments, used_units_by_faculty).
    """
    caps = _faculty_capacities(ctx)          # per-faculty hard cap (preferred or default)
    used: dict[str, int] = {fid: 0 for fid in caps}  # how many units we have allocated so far
    kept: list[dict] = []

    # DEBUG: snapshot of incoming assignments
    print(
        "[CAP_ENFORCE_IMPL] incoming:",
        [(a.get("section_id"), a.get("faculty_id"), a.get("course_id"))
         for a in assignments if a.get("faculty_id")]
    )
    print("[CAP_ENFORCE_IMPL] caps:", caps)

    for a in assignments:
        fid = a.get("faculty_id")
        cid = a.get("course_id")
        sid = a.get("section_id")
        if not fid or not cid:
            continue
        units = int((ctx.courses.get(cid) or {}).get("units") or 0)

        # skip if no capacity info for this faculty (or zero cap)
        cap = int(caps.get(fid, 0))
        if cap <= 0:
            print(
                f"[CAP_ENFORCE_IMPL] skip sid={sid} fid={fid} cid={cid} "
                f"because cap={cap}"
            )
            continue

        before = used.get(fid, 0)

        # keep only if this assignment still fits
        if before + units <= cap:
            kept.append(a)
            used[fid] = before + units
        else:
            # DEBUG: this is the important part – what exactly gets dropped?
            print(
                f"[CAP_ENFORCE_DROP] fid={fid} dropping sid={sid} cid={cid} "
                f"units={units} used_before={before} cap={cap}"
            )

    print("[CAP_ENFORCE_IMPL] final_used:", used)
    return kept, used

def _campus_compat_pref(fpref: dict, section_campus_id: str) -> bool:
    """
    Campus compatibility comes from faculty_preferences.mode.campus_id (array).
    Empty list = no restriction (compatible with any campus).
    """
    campus_list = ((fpref.get("mode") or {}).get("campus_id") 
                   or fpref.get("campus_id") or [])
    if not campus_list:
        return True
    sid = (section_campus_id or "").strip().upper()
    return sid in {str(x).strip().upper() for x in campus_list}

def _mode_compat_pref(fpref: dict, section_mode: str | None) -> bool:
    """
    Mode compatibility comes from faculty_preferences.mode.mode.
    HYB = wildcard; FOL/ONLINE accept ONLINE/HYB; ONSITE accepts ONSITE/HYB.
    Empty = no restriction.
    """
    pref = str(((fpref.get("mode") or {}).get("mode") 
               or fpref.get("preferred_mode") or "")).strip().upper()
    if not pref:
        return True
    m = (section_mode or "HYB").strip().upper()
    if pref == "HYB":
        return True
    if pref in ("FOL", "ONLINE"):
        return m in ("ONLINE", "HYB")
    if pref == "ONSITE":
        return m in ("ONSITE", "HYB")
    return True

# ---------------------- TIME / OVERLAP HELPERS (Phase 6B) ----------------------
_DAY_MAP = {
    "M": 1, "T": 2, "W": 3, "H": 4, "TH": 4, "F": 5, "S": 6, "U": 7,
    1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7
}

def _to_min(hhmm: str | int | None) -> int:
    if hhmm is None or hhmm == "": return -1
    s = str(hhmm).strip()
    if ":" in s:
        try:
            hh, mm = s.split(":")
            return int(hh) * 60 + int(mm)
        except Exception:
            return -1
    # remove non-digits, then zfill(4) for 3-digit inputs like "915"
    import re as _re
    digits = _re.sub(r"\D", "", s)
    if not digits:
        return -1
    if len(digits) == 3:
        digits = "0" + digits
    if len(digits) == 4:
        try:
            return int(digits[:2]) * 60 + int(digits[2:])
        except Exception:
            return -1
    return -1

def _conflict(a: tuple[int, int], b: tuple[int, int]) -> bool:
    """(start, end) in minutes; treat empty as non-conflicting."""
    sa, ea = a; sb, eb = b
    if min(sa, ea, sb, eb) < 0: return False
    return not (ea <= sb or eb <= sa)

def _mm_to_hhmm(m: int) -> str:
    if m is None or m < 0: return ""
    h = m // 60
    mm = m % 60
    return f"{h:02d}:{mm:02d}"

def _flag_faculty_conflicts(rows: list[dict], resolve_conflicts: bool = False) -> None:
    """
    - Looks at final rows (faculty_id, day1/2, begin1/2, end1/2).
    - Flags any overlapping time windows per faculty+day.
    - If resolve_conflicts=True:
         "weaker" row gets unassigned (no overlap in final timetable).
      If resolve_conflicts=False:
         we only tag them as Conflict in status/conflictNote.
    """

    # Build: faculty_id -> day -> list of slots (st_min, en_min, row)
    fac_day_slots: dict[str, dict[str, list[dict]]] = {}

    for r in rows:
        fid = (r.get("faculty_id") or "").strip()
        if not fid:
            continue

        for which in ("1", "2"):
            day = (r.get(f"day{which}") or "").strip()
            b = (r.get(f"begin{which}") or "").strip()
            e = (r.get(f"end{which}") or "").strip()
            if not (day and b and e):
                continue

            st = _to_min(b)
            en = _to_min(e)
            if st is None or en is None or en <= st:
                continue

            fac_day_slots.setdefault(fid, {}).setdefault(day, []).append(
                {"st": st, "en": en, "row": r}
            )

    def _priority(row: dict) -> int:
        """
        Smaller number = stronger row we prefer to keep.
        Example priorities (tweak if you want):
        - Confirmed < Pending < others
        """
        status = (row.get("status") or "").lower()
        if status == "confirmed":
            return 0
        if status == "pending":
            return 1
        return 2

    # Detect overlaps per faculty+day
    for fid, day_map in fac_day_slots.items():
        for day, slots in day_map.items():
            if len(slots) < 2:
                continue

            # Sort by start time
            slots.sort(key=lambda s: s["st"])

            kept: list[dict] = []
            for slot in slots:
                st, en, row = slot["st"], slot["en"], slot["row"]
                conflict_with = None

                # Check overlap with any kept slot
                for k in kept:
                    ks, ke, krow = k["st"], k["en"], k["row"]
                    # overlapping if intervals intersect with positive length
                    if st < ke and ks < en:
                        conflict_with = k
                        break

                if conflict_with is None:
                    kept.append(slot)
                    continue

                # We have a clash between row and conflict_with["row"]
                row_a = row
                row_b = conflict_with["row"]

                # Mark both as having a clash in conflictNote/status
                for rr in (row_a, row_b):
                    # Don't override unassigned status, but tag everything else
                    if (rr.get("status") or "").lower() != "unassigned":
                        rr["status"] = "Conflict"

                    msg = (
                        f"Faculty schedule clash on {day} "
                        f"({ _mm_to_hhmm(st) }–{ _mm_to_hhmm(en) })."
                    )
                    existing = (rr.get("conflictNote") or "").strip()
                    if msg not in existing:
                        rr["conflictNote"] = (existing + " " + msg).strip().lstrip()

                if not resolve_conflicts:
                    # For fetch/conflict-tab use: just flag, keep both
                    kept.append(slot)
                    continue

                # --- resolve_conflicts=True: choose which row to drop ---
                # Prefer to keep row with "better" priority (smaller number)
                if _priority(row_a) < _priority(row_b):
                    stronger, weaker = row_a, row_b
                else:
                    stronger, weaker = row_b, row_a

                # Unassign weaker row to remove clash in final timetable
                weaker["faculty_id"] = ""
                weaker["faculty"] = ""
                # Keep mode as-is; just unassign and mark appropriately
                weaker["status"] = "Unassigned"

                for k in ("day1","begin1","end1","day2","begin2","end2","room1","room2"):
                    weaker[k] = ""

                extra_msg = f" Auto-assign dropped this faculty due to clash with another section."
                existing = (weaker.get("conflictNote") or "").strip()
                if extra_msg not in existing:
                    weaker["conflictNote"] = (existing + " " + extra_msg).strip().lstrip()

                # Stronger stays in kept; weaker is not added (no future overlap from it)
                if conflict_with not in kept:
                    kept.append(conflict_with)
                # current slot is the weaker one (or stronger); ensure the stronger is in kept
                if stronger is row_a:
                    # ensure current slot references stronger
                    slot["row"] = stronger
                    slot["st"], slot["en"] = st, en
                    kept.append(slot)

MAX_CONSEC_TEACH_MIN = 4 * 60 + 30   # 4.5 hours
MAX_GAP_FOR_STREAK   = 15            # minutes between classes still counted in a streak

def _streak_ok_for_day(
    existing: list[tuple[int, int]],
    new_slots: list[tuple[int, int]],
    max_minutes: int = MAX_CONSEC_TEACH_MIN,
    gap_tol: int = MAX_GAP_FOR_STREAK,
) -> bool:
    """
    Ensure that, on a single day, the total length of a 'teaching streak'
    (blocks separated by <= gap_tol minutes) never exceeds max_minutes.

    Example:
      07:30–09:00, 09:15–10:45, 11:00–12:30 on the same day
      → 3 x 90min = 270min teaching in a 5h window → REJECT when max_minutes=270.
    """
    intervals = [(s, e) for (s, e) in (existing + new_slots) if s >= 0 and e > s]
    if not intervals:
        return True

    intervals.sort()  # by start time
    streak_start, streak_end = intervals[0]
    streak_teach = streak_end - streak_start

    for st, en in intervals[1:]:
        gap = st - streak_end
        dur = en - st

        if gap <= gap_tol:
            # extend current streak
            streak_end = en
            streak_teach += dur
        else:
            # start a new streak
            streak_start, streak_end = st, en
            streak_teach = dur

        if streak_teach >= max_minutes:
            return False

    return True

def _slots_from_scheds(scheds: list[dict]) -> list[tuple[int, tuple[int,int]]]:
    """
    Return [(day_int, (start_min, end_min)), ...] for all entries in scheds.
    Accepts either {day:'M', start_time:'07:30', end_time:'09:00', ...} shaped docs.
    """
    out = []
    for s in scheds or []:
        d_raw = s.get("day") or s.get("day_of_week") or s.get("day1") or s.get("day2") or ""
        # normalize TH/H
        d = str(d_raw).strip().upper()
        if d == "TH": d = "H"
        di = _DAY_MAP.get(d, _DAY_MAP.get(d[:1], -1))
        st = _to_min(s.get("start_time") or s.get("begin") or s.get("begin1") or s.get("start"))
        en = _to_min(s.get("end_time")   or s.get("end")   or s.get("end1")   or s.get("finish"))
        if di in _DAY_MAP.values():
            out.append((di, (st, en)))
    return out

def _to_compact_hhmm(hhmm: str) -> str:
    """'07:30' → '730', '09:15' → '915'."""
    m = _to_min(hhmm)         
    if m < 0: 
        return ""
    h, mm = divmod(m, 60)
    return f"{h}{mm:02d}"

# ------------------------------------------------------------------------------

# ---------------------- FACULTY OCCUPIED GRID + PREFS -------------------------
def _build_faculty_grid(
    ctx: ContextA,
    tentative: list[dict],
) -> dict[str, dict[int, list[tuple[int,int]]]]:
    """
    Returns: { faculty_id: { day_int: [(start,end), ...] } } using:
      • existing normalized schedules_by_section
      • tentative Phase 6A assignments (using those same schedules)
    """
    grid: dict[str, dict[int, list[tuple[int,int]]]] = {}

    # seed with current (already-known) loads if you keep them in ctx later; for now, only tentative
    for a in tentative:
        fid = a.get("faculty_id"); sid = a.get("section_id")
        if not fid or not sid: continue
        slots = _slots_from_scheds((ctx.schedules_by_section or {}).get(sid, []))
        for di, interval in slots:
            grid.setdefault(fid, {}).setdefault(di, []).append(interval)

    # normalize + coalesce intervals per day for quick checks
    for fid, days in grid.items():
        for di, arr in days.items():
            arr.sort()
            merged: list[tuple[int,int]] = []
            for st, en in arr:
                if not merged or merged[-1][1] <= st:
                    merged.append((st, en))
                else:
                    last_st, last_en = merged[-1]
                    merged[-1] = (last_st, max(last_en, en))
            days[di] = merged
    return grid

def _pref_accepts_slot(fpref: dict, di: int, interval: tuple[int,int]) -> bool:
    """
    STRICT VERSION:
      - Faculty must allow the day.
      - The section interval must be fully inside one of the faculty’s preferred windows.
      - If no preferred_times set: accept any time on allowed days.
    """
    if not fpref:
        # print("DEBUG-PREF: fpref empty → ACCEPT (no preferences)")
        return True

    start, end = interval

    # --- Day filtering ---
    avail = fpref.get("availability_days") or []
    if avail:
        allowed: set[int] = set()
        for d in avail:
            if not d: continue
            k = d[0].upper()
            if k == "M": allowed.add(1)
            elif k == "T": allowed.add(2)
            elif k == "W": allowed.add(3)
            elif k in ("H","T","TH"): allowed.add(4)
            elif k == "F": allowed.add(5)
            elif k == "S": allowed.add(6)

        if di not in allowed:
            # print(f"DEBUG-PREF: Day {di} not in availability_days {avail} → REJECT")
            return False

    # --- Time-window strict filtering ---
    raw = fpref.get("preferred_times") or []
    windows: list[tuple[int,int]] = []

    for w in raw:
        st = en = None
        if isinstance(w, dict):
            st = w.get("start") or w.get("begin")
            en = w.get("end") or w.get("finish")
        elif isinstance(w, (list,tuple)) and len(w)==2:
            st, en = w
        elif isinstance(w, str):
            s = w.replace("–","-").replace("—","-")
            if "-" in s:
                a,b = s.split("-",1)
                st,en = a,b

        if st and en:
            st_min = _to_min(st)
            en_min = _to_min(en)
            if st_min is not None and en_min is not None and en_min > st_min:
                windows.append((st_min, en_min))

    if not windows:
        # print("DEBUG-PREF: No preferred_times → ACCEPT (day allowed)")
        return True

    for ws, we in windows:
        if start >= ws and end <= we:
            # print(f"DEBUG-PREF: interval {interval} fits inside preferred window {(ws,we)} → ACCEPT")
            return True

    # print(f"DEBUG-PREF: interval {interval} does NOT fit preferred windows {windows} → REJECT")
    return False

# --- IDs / normalize helpers (place near _fmt_time / _mm_to_hhmm) ---
def _sched_id(section_id: str, ordinal: int) -> str:
    # SEC0001 -> SCH0001-01, SCH0001-02
    tail = (section_id or "").replace("SEC", "")
    return f"SCH{tail}-{ordinal:02d}"

def _norm_hhmm(s: str | None) -> str:
    return _fmt_time(s)  # reuse your tolerant formatter

def _next_section_seq_from_ctx(ctx) -> int:
    """
    Find the largest numeric tail among section_ids like 'SEC0001'
    and return the next integer to use (e.g. 42 => 'SEC0042').
    """
    max_seq = 0
    for s in getattr(ctx, "sections", []) or []:
        sid = (s.get("section_id") or "").strip()
        if not sid.startswith("SEC"):
            continue
        tail = sid[3:]
        if tail.isdigit():
            n = int(tail)
            if n > max_seq:
                max_seq = n
    return max_seq + 1

# ------------------------------ PHASE 5 ------------------------------
def _coordinator_for_course(ctx: ContextA, cid: str) -> list[str]:
    c = (ctx.courses or {}).get(cid) or {}
    raw = c.get("course_coordinator") or c.get("coordinator_faculty_id") or c.get("coordinator")
    if not raw:
        return []

    vals = raw if isinstance(raw, list) else [raw]
    # build user_id -> faculty_id map
    uid_to_fid = {f.get("user_id"): f.get("faculty_id") for f in ctx.faculty if f.get("user_id") and f.get("faculty_id")}
    out: list[str] = []
    for v in vals:
        if not isinstance(v, str) or not v:
            continue
        if v.startswith("USR"):           # looks like user_id
            fid = uid_to_fid.get(v)
            if fid:
                out.append(fid)
        else:
            out.append(v)                 # assume already a faculty_id
    # unique, preserve order
    seen = set(); ret = []
    for fid in out:
        if fid and fid not in seen:
            seen.add(fid); ret.append(fid)
    return ret

def _compute_topk_for_course(by_course: dict, cid: str, candidates: list[dict], max_topk: int = 5) -> list[str]:
    """
    Phase 5: Dynamic Top-K = min(max_topk, #sections under the course, #candidates), at least 1.
    Returns faculty_ids from the *ranked* candidates list.
    """
    n_sections = len((by_course.get(cid) or {}).get("sections", []))
    k = max(1, min(max_topk, n_sections, len(candidates)))
    return [c["faculty_id"] for c in candidates[:k]]

def _effective_kacs_for_faculty(ctx: ContextA, f: dict) -> set[str]:
    """
    Return the union of a faculty’s preferred and qualified KACs.
    Used for solo-KAC detection.
    """
    fid = f.get("faculty_id")
    prefs = set((ctx.prefs_by_faculty.get(fid) or {}).get("preferred_kacs") or [])
    qual = set(f.get("qualified_kacs") or f.get("kac_ids") or [])
    return prefs | qual

def _apply_protection_tags(by_course: dict, cid: str, coord_ids: list[str], topk_ids: list[str]) -> None:
    """
    Phase 5: Tag protected faculty for this course.
    Structure: by_course[cid]["protection_tags"] = { faculty_id: ["coordinator","topK", ...] }
    Handles both list and set types safely.
    """
    tags = (by_course.setdefault(cid, {})).setdefault("protection_tags", {})

    def _as_set(x):
        if isinstance(x, set):
            return x
        if isinstance(x, list):
            return set(x)
        return set()

    # add coordinator tags
    for fid in coord_ids or []:
        cur = _as_set(tags.get(fid))
        cur.add("coordinator")
        tags[fid] = cur

    # add Top-K tags
    for fid in topk_ids or []:
        cur = _as_set(tags.get(fid))
        cur.add("topK")
        tags[fid] = cur

    # normalize sets → lists for JSON safety
    by_course[cid]["protection_tags"] = {fid: sorted(list(_as_set(v))) for fid, v in tags.items()}

def _apply_solo_kac_tags(ctx: ContextA, by_course: dict, cid: str, candidates: list[dict], course_kacs: set[str]) -> None:
    """
    Phase 5: If a candidate has exactly one effective KAC and that KAC is in this course's KACs,
    tag them as 'soloKAC' so later phases can protect/prioritize them for this KAC.
    """
    if not course_kacs:
        return
    tags = (by_course.setdefault(cid, {})).setdefault("protection_tags", {})
    for c in candidates:
        fid = c.get("faculty_id")
        if not fid:
            continue
        # pull the original faculty/profile doc from ctx
        fdoc = next((x for x in ctx.faculty if x.get("faculty_id") == fid), None)
        if not fdoc:
            continue
        eff = _effective_kacs_for_faculty(ctx, fdoc)
        if len(eff) == 1:
            sk = next(iter(eff))
            if sk in course_kacs:
                tags.setdefault(fid, set()).add("soloKAC")
    # normalize sets → lists
    by_course[cid]["protection_tags"] = {fid: sorted(list(v)) for fid, v in tags.items()}
# --------------------------- END PHASE 5 -----------------------------

async def _room_type_from_row(r: dict, ordn: int, db=None) -> str | None:
    """
    Determine room_type for section_schedules based on section + course mode rules.
    Rules:
      - If section['mode'] == 'HYB':
          * CMPS0001 campus: Room 1 = Online (room_id null)
            Room 2 = if no room_id yet, use course.room_type as temp display value
          * CMPS0002 campus: reverse logic (Online for Room 2)
      - If section['mode'] == 'FOL':
          * Both Room 1 and Room 2 = Online (room_id null)
    """
    sid = r.get("section_id") or r.get("id")
    if not sid or not db:
        return None

    # Fetch section to get mode and campus
    section = await db["sections"].find_one({"section_id": sid}, {"_id": 0, "mode": 1, "campus_id": 1, "course_id": 1})
    if not section:
        return None

    mode = (str(r.get("mode") or "").upper() or str(section.get("mode") or "").upper())
    campus_id = section.get("campus_id")
    course_id = section.get("course_id")

    # Fetch course to get its room_type
    course = await db["courses"].find_one({"course_id": course_id}, {"_id": 0, "room_type": 1})
    course_room_type = (course or {}).get("room_type") or "Online"

    # --- Logic ---
    if mode == "HYB":
        # CMPS0001 campus
        if campus_id == "CMPS0001":
            if ordn == 1:
                return "Online"
            else:
                return course_room_type  # fallback room type for display
        # CMPS0002 campus
        elif campus_id == "CMPS0002":
            if ordn == 1:
                return course_room_type
            else:
                return "Online"

    elif mode == "FOL":
        return "Online"

    # No mode decided → do not set a room_type
    return None

# =============  MILESTONE C — Phase 6A (Capacity-first matching; no time/day)  =============
# Goal: iterate in KAC→course order, and for each course exhaust the top faculty's
# remaining units on its sections before moving to the next faculty (time/day ignored for now).

def _section_units(ctx: ContextA, cid: str) -> int:
    # prefer course units; fallback to 3
    return int((ctx.courses.get(cid) or {}).get("units") or 3)

def _course_sections(ctx: ContextA, by_course: dict, cid: str) -> list[str]:
    # preserve stable section order within a course
    return list(by_course.get(cid, {}).get("sections", []))

def _promote_protected_first(by_course: dict, cid: str, cand_list: list[dict]) -> list[dict]:
    """
    Phase 6A: Promote protected candidates:
      1) coordinators, then
      2) soloKAC,
    preserving relative order inside each bucket and overall stability.
    """
    tags = (by_course.get(cid, {}).get("protection_tags", {})) or {}
    def has(fid: str, tag: str) -> bool:
        return tag in (tags.get(fid) or [])
    coords, solos, others = [], [], []
    for c in cand_list:
        fid = c.get("faculty_id")
        if fid and has(fid, "coordinator"):
            coords.append(c)
        elif fid and has(fid, "soloKAC"):
            solos.append(c)
        else:
            others.append(c)
    return coords + solos + others

async def run_milestone_c_phase6a(term_id: str, db, department_id: str | None = None) -> dict:
    """
    Phase 6A: capacity-first, campus/mode-ready (already gated in Phase 5),
    NO time/day checking yet. Produces a list of tentative assignments.
    """

    # Rebuild context + ordering (reuse A/3 logic) and reuse B to get candidates
    ctx = await phase0_load(term_id, db, department_id)
    print("6A ctx.leave_blocked:", len(getattr(ctx, "leave_blocked", set()) or set()),
          "has FAC0002:", "FAC0002" in (getattr(ctx, "leave_blocked", set()) or set()))  # <-- ADD
    phase1_kac_helpers(ctx)
    phase3_kac_prioritization(ctx)

    # Build Phase 5 pools (call B once to avoid duplicating candidate logic)
    phase5 = await run_milestone_b(term_id, db, department_id)
    by_course = phase5.get("by_course", {})
    course_order = phase5.get("courses_order", []) or (ctx.course_order or [])

    # --- NEW: Enforce primary pass order: Foundation → SHS → others ---
    def _ctype_of(cid: str) -> str:
        c = (ctx.courses.get(cid) or {})
        t = (c.get("type") or c.get("type_of_course") or "Major")
        return str(t).strip().upper()

    buckets = {"FOUNDATION": [], "SHS": [], "OTHER": []}
    for cid in course_order:
        ct = _ctype_of(cid)
        if ct == "FOUNDATION":
            buckets["FOUNDATION"].append(cid)
        elif ct == "SHS":
            buckets["SHS"].append(cid)
        else:
            buckets["OTHER"].append(cid)

    # Final processing order
    course_order = buckets["FOUNDATION"] + buckets["SHS"] + buckets["OTHER"]

    # ----- Phase 6A KAC coverage bookkeeping (prioritize higher KACs) -----
    # total sections per KAC (from phase3 kac_stats), and per-KAC assigned so far
    kac_total_sections: dict[str, int] = {}
    kac_assigned: dict[str, int] = {}

    campus2_total = sum(1 for s in ctx.sections if (s.get("campus_id") or "").strip().upper() == "CMPS0002")
    campus2_assigned = 0

    # build course -> primary KAC map (choose the first KAC if multiple)
    course_to_primary_kac: dict[str, str] = {}
    for cid2 in course_order:
        kset = (getattr(ctx, "course_to_kacs", {}) or {}).get(cid2) or set()
        if kset:
            course_to_primary_kac[cid2] = next(iter(sorted(kset)))  # stable pick
    # fill totals from ctx.kac_stats if available
    for kid, ks in (getattr(ctx, "kac_stats", {}) or {}).items():
        kac_total_sections[kid] = int(ks.get("sections") or 0)
        kac_assigned[kid] = 0


    # capacities (preferred_units → remaining_units → default)
    caps = _faculty_capacities(ctx)
    caps_baseline = dict(caps)

    # quick lookups
    section_to_course = {s["section_id"]: s["course_id"] for s in ctx.sections}
    assigned: dict[str, dict] = {}  # section_id -> assignment doc
    per_course_assigned: dict[str, int] = {}

    # Main loop: KAC→course order
    for cid in course_order:
        sec_ids = [sid for sid in _course_sections(ctx, by_course, cid) if sid not in assigned]
        if not sec_ids:
            continue
        units_per_sec = _section_units(ctx, cid)

        # candidate list — already ranked; coordinators (if any) go first
        cand_list = list(by_course.get(cid, {}).get("candidates", []))
        cand_list = _promote_protected_first(by_course, cid, cand_list)

        # Precompute solo-KAC ownership for each faculty (for quick lookup)
        solo_kac_of_faculty: dict[str, str] = {}
        for course_id, info in by_course.items():
            tags = (info or {}).get("protection_tags", {}) or {}
            for fid_tag, taglist in tags.items():
                if "soloKAC" in (taglist or []) and fid_tag not in solo_kac_of_faculty:
                    solo_kac_of_faculty[fid_tag] = course_to_primary_kac.get(course_id)

        # --- NEW: local helper to enforce solo-CMPS0002 reservation until coverage ---
        def _campus2_reservation_allows(fid: str, section_campus_id: str) -> bool:
            # allow if the section is CMPS0002
            if (section_campus_id or "").strip().upper() == "CMPS0002":
                return True
            # if faculty is not solo-CMPS0002, no reservation applies
            fpref = (ctx.prefs_by_faculty.get(fid) or {})
            campus_list = ((fpref.get("mode") or {}).get("campus_id") or [])
            solo = {str(x).strip().upper() for x in campus_list if x} == {"CMPS0002"}
            if not solo:
                return True
            # solo-CMPS0002 must be preserved for CMPS0002 until ~80% coverage
            if campus2_total <= 0:
                return True
            if (section_campus_id or "").strip().upper() != "CMPS0002" and solo:
                return False
            return True

        # exhaust top candidate's units across the course before moving to next
        for c in cand_list:
            fid = c.get("faculty_id")
            if not fid:
                continue

            # NEW: hard guard — never assign someone on leave
            if fid in (getattr(ctx, "leave_blocked", set()) or set()):
                continue

            # NEW: hard guard — never assign someone on leave
            if fid in (getattr(ctx, "leave_blocked", set()) or set()):
                continue

            cap = int(caps.get(fid, 0))
            if cap < units_per_sec:
                continue

            # --- solo-KAC guard (reserve for their own KAC until covered) ---
            solo_kac_id = solo_kac_of_faculty.get(fid)

            current_kac = course_to_primary_kac.get(cid)
            if solo_kac_id and current_kac != solo_kac_id:
                total = int(kac_total_sections.get(solo_kac_id, 0))
                done  = int(kac_assigned.get(solo_kac_id, 0))
                # threshold (e.g., 80%): allow spillover after coverage ratio is reached
                SOLO_KAC_RELEASE_RATIO = 0.80
                if total > 0:
                    covered = (done / total) >= SOLO_KAC_RELEASE_RATIO
                    if not covered:
                        continue

            # Assign as many unassigned sections of this course as capacity allows
            i = 0
            while i < len(sec_ids) and cap >= units_per_sec:
                sid = sec_ids[i]
                if sid in assigned:
                    i += 1
                    continue

                # --- NEW: reservation guard before committing ---
                sec = next((x for x in ctx.sections if x.get("section_id") == sid), {}) or {}
                sec_campus = (sec.get("campus_id") or "").strip().upper()
                fpref_local = (ctx.prefs_by_faculty.get(fid) or {})
                # campus check (strict, using THIS section’s campus)
                if not _campus_compat_pref(fpref_local, sec_campus):
                    i += 1
                    continue
                # mode check (use the section’s declared mode; default HYB if unset)
                sec_mode = (sec.get("mode") or "HYB")
                if not _mode_compat_pref(fpref_local, sec_mode):
                    i += 1
                    continue

                # (Phase 6A skips time/day; campus/mode already gated in Phase 5)
                assigned[sid] = {
                    "section_id": sid,
                    "course_id": cid,
                    "faculty_id": fid,
                    "faculty": c.get("name", ""),
                    "status": "Pending",
                }
                cap -= units_per_sec
                caps[fid] = cap
                per_course_assigned[cid] = per_course_assigned.get(cid, 0) + 1

                # ---- KAC coverage++ for the course's primary KAC  ----
                pk = course_to_primary_kac.get(cid)
                if pk:
                    kac_assigned[pk] = kac_assigned.get(pk, 0) + 1

                # --- NEW: campus2 coverage++ when applicable ---
                if sec_campus == "CMPS0002":
                    campus2_assigned += 1
                # -------------------------------------------------

                i += 1

            # refresh remaining unassigned list for this course (important!)
            sec_ids = [sid for sid in sec_ids if sid not in assigned]
            if not sec_ids:
                break

    # Shape return structure compatible with route
    assignments = list(assigned.values())

    # ------------------------------ PHASE 6A DEBUG ------------------------------
    # Collect per-faculty assignments summary for inspection
    faculty_debug: dict[str, dict] = {}
    for a in assignments:
        fid = a["faculty_id"]
        entry = faculty_debug.setdefault(fid, {"faculty": a.get("faculty", ""), "courses": set()})
        entry["courses"].add(a["course_id"])
    # Build readable list (include ALL faculty, even with no assignments)
    phase6a_faculty_debug = []
    assigned_map = {}  # faculty_id -> set(courses)
    for a in assignments:
        assigned_map.setdefault(a["faculty_id"], set()).add(a["course_id"])

    for f in ctx.faculty:
        fid = f["faculty_id"]
        phase6a_faculty_debug.append({
            "faculty_id": fid,
            "faculty_name": _display_name_from_users(ctx.users_by_faculty.get(fid)),
            "remaining_units": int(caps.get(fid, 0)),
            "courses_assigned": sorted(list(assigned_map.get(fid, set()))),
        })
    # ---------------------------------------------------------------------------

    # compute used units per faculty
    faculty_units = {}
    for a in assignments:
        fid = a.get("faculty_id")
        if not fid:
            continue
        units = (ctx.courses.get(a.get("course_id"), {}).get("units") or 0)
        faculty_units[fid] = faculty_units.get(fid, 0) + int(units)

    # compute each faculty's preferred cap
    preferred_cap = {}
    for fid in caps.keys():
        pref_doc = (ctx.prefs_by_faculty or {}).get(fid, {})
        preferred_cap[fid] = (
            pref_doc.get("preferred_units")
            or pref_doc.get("load_units")
            or 12
        )

    phase6a_used_units = {}
    for a in assignments:
        fid = a.get("faculty_id")
        units = int((ctx.courses.get(a.get("course_id"), {}) or {}).get("units") or 0)
        phase6a_used_units[fid] = phase6a_used_units.get(fid, 0) + units

    base_cap_map = _faculty_capacities(ctx).copy()

    debug6a = {
        "phase6a_assigned_total": len(assignments),
        "phase6a_per_course": per_course_assigned,
        "phase6a_per_kac": {k: {"assigned": int(kac_assigned.get(k, 0)), "total": int(kac_total_sections.get(k, 0))}
                            for k in sorted(set(kac_total_sections) | set(kac_assigned))},
        "phase6a_used_units": {fid: int(u) for fid, u in phase6a_used_units.items()},
        "phase6a_preferred_units": {
            fid: int(preferred_cap.get(fid, 12))
            for fid in caps.keys()
        },
        "phase6a_caps_left": {
            fid: f"{int(phase6a_used_units.get(fid, 0))}/{int(preferred_cap.get(fid, 12))}"
            for fid in caps.keys()
        },
        "phase6a_faculty_debug": phase6a_faculty_debug,
    }

    # Keep by_course and earlier debug fields for inspection
    return {
        "term_id": term_id,
        "courses_order": course_order,
        "by_course": by_course,
        "assignments": assignments,
        "debug": {**(phase5.get("debug", {}) or {}), **debug6a},
    }
# =============  END MILESTONE C — Phase 6A  ==========================

# =============  MILESTONE D — Phase 6B (Feasibility + Minimal Reshuffle)  =============
async def run_milestone_d_phase6b(term_id: str, db, department_id: str | None = None) -> dict:
    """
    Build on Phase 6A: validate time/day feasibility against:
      • section_schedules
      • faculty availability_days / preferred_times
    Keep feasible, try minimal reshuffle for conflicts (same-course candidates first),
    then mark leftovers as 'Conflict'.
    """
    # 1) Run 6A to get tentative picks + candidate pools
    res6a = await run_milestone_c_phase6a(term_id, db, department_id)
    assignments = list(res6a.get("assignments", []))
    by_course = dict(res6a.get("by_course", {}))

    # 2) Rebuild context to read schedules/prefs quickly
    ctx = await phase0_load(term_id, db, department_id)
    print("6B ctx.leave_blocked:", len(getattr(ctx, "leave_blocked", set()) or set()),
          "has FAC0002:", "FAC0002" in (getattr(ctx, "leave_blocked", set()) or set()))

    # 3) Prepare grids & quick lookups
    fac_pref = ctx.prefs_by_faculty or {}
    grid = _build_faculty_grid(ctx, assignments)
    caps_after_6a = {}  # we’ll reconstruct remaining units from 6A debug
    for fdbg in (res6a.get("debug", {}) or {}).get("phase6a_faculty_debug", []):
        caps_after_6a[fdbg["faculty_id"]] = int(fdbg.get("remaining_units", 0))

    section_course = {s["section_id"]: s["course_id"] for s in ctx.sections}
    feasible: list[dict] = []
    conflicts: list[dict] = []

    # helper to test if (fid, sid) is sched-feasible & pref-accepted
    def _is_ok(fid: str, sid: str) -> bool:
        slots = _slots_from_scheds((ctx.schedules_by_section or {}).get(sid, []))
        if not slots:
            return True  # no schedule registered → treat as okay

        for di, itv in slots:
            # 1) preference acceptance
            if not _pref_accepts_slot(fac_pref.get(fid, {}), di, itv):
                return False

            existing = grid.get(fid, {}).get(di, [])

            # 2) hard conflict with existing intervals
            for cur in existing:
                if _conflict(cur, itv):
                    return False

            # 3) 4.5h consecutive-teaching rule
            if not _streak_ok_for_day(existing, [itv]):
                return False

        return True


    # 4) First pass: keep feasible, collect conflict pool
    for a in assignments:
        fid, sid = a["faculty_id"], a["section_id"]
        if _is_ok(fid, sid):
            feasible.append(a)
        else:
            conflicts.append(a)

    # 5) Minimal reshuffle: try to reassign each conflict using Phase 5 pool
    #    Priority: same-course candidates, keep protection order via _promote_protected_first
    reassigned: list[dict] = []
    unresolved: list[dict] = []
    for a in conflicts:
        sid = a["section_id"]; cid = a["course_id"]
        cinfo = by_course.get(cid, {})
        cand_list = list(cinfo.get("candidates", []))
        cand_list = _promote_protected_first(by_course, cid, cand_list)

        units = int((ctx.courses.get(cid) or {}).get("units") or 3)
        found = None
        for c in cand_list:
            fid2 = c.get("faculty_id")
            if not fid2: 
                continue
            if fid2 == a["faculty_id"]:
                continue

            # NEW: also respect leave here
            if fid2 in (getattr(ctx, "leave_blocked", set()) or set()):
                continue

            if int(caps_after_6a.get(fid2, 0)) < units:
                continue
            if not _is_ok(fid2, sid):
                continue
            # OK → assign to fid2
            
            found = {
                **a,
                "faculty_id": fid2,
                "faculty": c.get("name", a.get("faculty", "")),
                "status": "Pending",
            }
            # update grid & caps
            slots = _slots_from_scheds((ctx.schedules_by_section or {}).get(sid, []))
            for di, itv in slots:
                grid.setdefault(fid2, {}).setdefault(di, []).append(itv)
            caps_after_6a[fid2] = int(caps_after_6a.get(fid2, 0)) - units
            break

        if found:
            reassigned.append(found)
        else:
            unresolved.append(a)

    # 6) Finalize results
    #    - keep original feasible
    #    - replace conflicted with reassigned where found
    #    - mark unresolved as Conflict (with light note)
    final_assignments = []
    assigned_sids = set()
    for a in feasible + reassigned:
        final_assignments.append(a)
        assigned_sids.add(a["section_id"])
    for a in unresolved:
        if a["section_id"] in assigned_sids:
            continue
        final_assignments.append({**a, "status": "Conflict", "conflictNote": "Time/day clash or pref mismatch"})

    # Debug payload
    debug6b = {
        "phase6b_kept": len(feasible),
        "phase6b_reassigned": len(reassigned),
        "phase6b_unresolved": len(unresolved),
        "phase6b_unresolved_sections": [a["section_id"] for a in unresolved],
    }
    
    return {
        **res6a,
        "assignments": final_assignments,
        "debug": {**(res6a.get("debug") or {}), **debug6b},
    }
# =============  END MILESTONE D — Phase 6B  ==========================

POLICY_ALLOW_SHS_SACRIFICE_IF_NO_CAPACITY = True

def _total_remaining_capacity(ctx, assignments) -> int:
    units = {cid: int((ctx.courses.get(cid) or {}).get("units") or 3) for cid in ctx.courses}
    caps  = _faculty_capacities(ctx)
    used  = {}
    for a in assignments:
        fid, cid = a.get("faculty_id"), a.get("course_id")
        if fid and cid:
            used[fid] = used.get(fid, 0) + units.get(cid, 3)
    rem = 0
    for fid, cap in caps.items():
        rem += max(0, cap - used.get(fid, 0))
    return rem

# =============  MILESTONE D2 — Rebalance: borrow from SHS to cover non-SHS  =============
async def run_milestone_d2_rebalance_shs_to_cover_nshs(term_id: str, db, department_id: str | None = None) -> dict:
    """
    Start from Phase 6B results, then:
      1) Find any non-SHS sections with no assignment (missing) or marked Conflict/Unassigned.
      2) Search SHS-assigned faculty for a compatible match (KAC/campus/mode + time/prefs).
      3) If compatible, move the faculty from SHS → the empty non-SHS, and release the SHS section.
      4) Optionally try to backfill the released SHS from its candidate pool.
    """
    base = await run_milestone_d_phase6b(term_id, db, department_id)
    assignments: list[dict] = list(base.get("assignments", []))

    # Rebuild context + quick lookups
    ctx = await phase0_load(term_id, db, department_id)
    by_course = dict(base.get("by_course", {})) or {}
    schedules_by_section = ctx.schedules_by_section or {}

    def _ctype(cid: str) -> str:
        c = (ctx.courses.get(cid) or {})
        t = (c.get("type") or c.get("type_of_course") or "Major")
        return str(t).strip().upper()

    # Build convenience maps
    section_to_course = {s["section_id"]: s["course_id"] for s in ctx.sections}
    assigned_by_sid = {a["section_id"]: a for a in assignments}
    all_sids = [s["section_id"] for s in ctx.sections]

    # Identify targets: non-SHS sections that are missing or unresolved
    empty_nshs: list[str] = []
    for sid in all_sids:
        cid = section_to_course.get(sid)
        if not cid or _ctype(cid) == "SHS":
            continue
        a = assigned_by_sid.get(sid)
        if not a or (a.get("status", "").lower() in ("conflict", "unassigned")):
            empty_nshs.append(sid)

    # Build pool of SHS assignees we can potentially borrow from
    shs_pool: list[dict] = []
    for a in assignments:
        cid = a.get("course_id")
        if _ctype(cid) == "SHS" and a.get("faculty_id"):
            shs_pool.append(a)

    # Helpers we already have in file
    def _is_sched_ok(fid: str, sid: str) -> bool:
        # reuse Phase 6B helpers
        slots = _slots_from_scheds(schedules_by_section.get(sid, []))
        if not slots:
            return True
        fpref = (ctx.prefs_by_faculty or {}).get(fid, {})
        # Build a faculty grid from current assignments (excluding the SHS one we might remove)
        tentative = [x for x in assignments if x.get("faculty_id") == fid and x.get("section_id") != sid]
        grid = _build_faculty_grid(ctx, tentative)
        for di, itv in slots:
            if not _pref_accepts_slot(fpref, di, itv):
                return False
            for cur in grid.get(fid, {}).get(di, []):
                if _conflict(cur, itv):
                    return False
        return True

    def _campus_mode_ok(fid: str, sid: str) -> bool:
        sec = next((x for x in ctx.sections if x["section_id"] == sid), {})
        fpref = (ctx.prefs_by_faculty or {}).get(fid, {}) or {}
        cid = section_to_course.get(sid, "")
        if not _gs_ok(ctx, fid, cid):
            return False
        return (
            _campus_compat_pref(fpref, sec.get("campus_id") or "") and
            _mode_compat_pref(fpref, sec.get("mode"))
        )

    # Rebalance loop: for each empty non-SHS, try to borrow one SHS faculty
    borrowed = []
    for sid in empty_nshs:
        cid = section_to_course.get(sid)
        if not cid:
            continue

        # Try each SHS assignee as a donor, but only if we can backfill their SHS first
        moved = False
        for shs_a in list(shs_pool):
            donor_fid = shs_a.get("faculty_id")
            shs_sid   = shs_a.get("section_id")
            if not donor_fid or not shs_sid:
                continue
            if donor_fid in (getattr(ctx, "leave_blocked", set()) or set()):
                continue
            # donor must fit the non-SHS target
            if not _campus_mode_ok(donor_fid, sid):
                continue
            # KAC guard for target
            course_kacs = set((getattr(ctx, "course_to_kacs", {}) or {}).get(cid, set()))
            if course_kacs:
                f = next((x for x in ctx.faculty if x.get("faculty_id") == donor_fid), {})
                pref_kacs = set(((ctx.prefs_by_faculty.get(donor_fid) or {}).get("preferred_kacs") or []))
                qual_kacs = set(f.get("qualified_kacs") or f.get("kac_ids") or [])
                if not (course_kacs & (pref_kacs | qual_kacs)):
                    continue
            # time feasibility for donor on target
            if not _is_sched_ok(donor_fid, sid):
                continue

            # --- Look ahead: can we backfill the SHS section (shs_sid) right now? ---
            shs_cid = section_to_course.get(shs_sid)
            cinfo = by_course.get(shs_cid, {})
            cand_list = list(cinfo.get("candidates", []))
            cand_list = _promote_protected_first(by_course, shs_cid, cand_list)
            backfill = None
            for c in cand_list:
                fid2 = c.get("faculty_id")
                if not fid2 or fid2 == donor_fid:
                    continue
                if fid2 in (getattr(ctx, "leave_blocked", set()) or set()):
                    continue
                if not _campus_mode_ok(fid2, shs_sid):
                    continue
                if not _is_sched_ok(fid2, shs_sid):
                    continue
                # KAC for SHS backfill
                shs_kacs = set((getattr(ctx, "course_to_kacs", {}) or {}).get(shs_cid, set()))
                if shs_kacs:
                    f2 = next((x for x in ctx.faculty if x.get("faculty_id") == fid2), {})
                    pk2 = set(((ctx.prefs_by_faculty.get(fid2) or {}).get("preferred_kacs") or []))
                    qk2 = set(f2.get("qualified_kacs") or f2.get("kac_ids") or [])
                    if not (shs_kacs & (pk2 | qk2)):
                        continue
                backfill = fid2
                break

            # If no backfill found, skip this donor (keep SHS intact)
            if not backfill:
                continue

            # --- Perform atomic swap: move donor to non-SHS AND assign backfill to SHS ---
            donor_name = shs_a.get("faculty", "")
            # 1) assign donor to target non-SHS
            new_a = {
                "section_id": sid,
                "course_id": cid,
                "faculty_id": donor_fid,
                "faculty": donor_name,
                "status": "Pending",
            }
            assignments = [a for a in assignments if a.get("section_id") != sid] + [new_a]

            # 2) assign backfill to the released SHS
            backfill_name = _display_name_from_users(ctx.users_by_faculty.get(backfill))
            shs_new = {
                "section_id": shs_sid,
                "course_id": shs_cid,
                "faculty_id": backfill,
                "faculty": backfill_name,
                "status": "Pending",
            }
            assignments = [a for a in assignments if a.get("section_id") != shs_sid] + [shs_new]

            # 3) update pools and logs
            shs_pool = [a for a in shs_pool if a.get("section_id") != shs_sid]  # donor removed
            borrowed.append({"from_shs": shs_sid, "to_nshs": sid, "faculty_id": donor_fid, "backfill": backfill})
            moved = True
            break  # stop scanning donors for this sid

        # go to next empty non-SHS; if not moved, it stays empty for now

    debug_d2 = {
        "d2_borrowed_count": len(borrowed),
        "d2_borrowed_pairs": borrowed,
        "d2_shs_backfilled": len([b for b in borrowed if b.get("backfill")]),
    }

    return {
        **base,
        "assignments": assignments,
        "debug": {**(base.get("debug") or {}), **debug_d2},
    }

# =============  END MILESTONE D2  =============

def _is_pt(ctx, fid: str) -> bool:
    f = next((x for x in ctx.faculty if x.get("faculty_id") == fid), {})
    return (f.get("employment_type") or "").strip().upper() == "PT"

def _is_ft(ctx, fid: str) -> bool:
    f = next((x for x in ctx.faculty if x.get("faculty_id") == fid), {})
    return (f.get("employment_type") or "").strip().upper() == "FT"

def _is_solo_campus2_pref(ctx, fid: str) -> bool:
    p = (ctx.prefs_by_faculty.get(fid) or {})
    camp = ((p.get("mode") or {}).get("campus_id") or [])
    return {str(x).strip().upper() for x in camp if x} == {"CMPS0002"}

def _mode_of_pref(ctx, fid: str) -> str:
    p = (ctx.prefs_by_faculty.get(fid) or {})
    return str(((p.get("mode") or {}).get("mode") or "")).strip().upper()

def _section_campus(ctx, sid: str) -> str:
    s = next((x for x in ctx.sections if x.get("section_id") == sid), {})
    return (s.get("campus_id") or "").strip().upper()

def _section_course(ctx, sid: str) -> str:
    s = next((x for x in ctx.sections if x.get("section_id") == sid), {})
    return s.get("course_id") or ""

def _course_requires_phd(ctx: ContextA, cid: str) -> bool:
    c = (ctx.courses.get(cid) or {})
    lvl = str(c.get("program_level") or "").strip().upper()
    return lvl == "GS"

def _has_phd_cert(ctx: ContextA, fid: str) -> bool:
    f = next((x for x in ctx.faculty if x.get("faculty_id") == fid), {})
    certs = [str(x).strip().upper() for x in (f.get("certifications") or [])]
    return "PHD" in certs

def _gs_ok(ctx: ContextA, fid: str, cid: str) -> bool:
    """
    GS courses (program_level=GS) must be taught by faculty with a PhD.
    """
    if not _course_requires_phd(ctx, cid):
        return True
    return _has_phd_cert(ctx, fid)

def _kac_ok(ctx, fid: str, cid: str) -> bool:
    # GS rule first: if the course requires PhD and faculty is not PhD → reject
    if not _gs_ok(ctx, fid, cid):
        return False

    course_kacs = set((getattr(ctx, "course_to_kacs", {}) or {}).get(cid, set()))
    if not course_kacs:
        return True
    fdoc = next((x for x in ctx.faculty if x.get("faculty_id") == fid), {})
    pref_kacs = set(((ctx.prefs_by_faculty.get(fid) or {}).get("preferred_kacs") or []))
    qual_kacs = set(fdoc.get("qualified_kacs") or fdoc.get("kac_ids") or [])
    return bool((pref_kacs | qual_kacs) & course_kacs)

def _campus_mode_ok_ctx(ctx, fid: str, sid: str) -> bool:
    sec = next((x for x in ctx.sections if x["section_id"] == sid), {})
    fpref = (ctx.prefs_by_faculty or {}).get(fid, {}) or {}
    return (
        _campus_compat_pref(fpref, sec.get("campus_id") or "") and
        _mode_compat_pref(fpref, sec.get("mode"))
    )

def _sched_ok_ctx(ctx, fid: str, sid: str, assignments: list[dict]) -> bool:
    """
    Check if faculty fid can teach section sid under ctx,
    given the current partial assignments.
    """

    # 1) Get fixed section schedule (if any)
    slots = _slots_from_scheds((ctx.schedules_by_section or {}).get(sid, []))
    if not slots:
        # Section has no fixed schedule; Phase 7 will handle proposals
        return True

    # 2) Faculty preferences
    fpref = (ctx.prefs_by_faculty or {}).get(fid, {})

    # 3) Build faculty grid from other assignments of this faculty
    tentative = [
        a for a in assignments
        if a.get("faculty_id") == fid and a.get("section_id") != sid
    ]
    grid = _build_faculty_grid(ctx, tentative)

    # 4) Check each slot of the section
    for di, itv in slots:
        # STRICT: preferences must accept the entire slot
        if not _pref_accepts_slot(fpref, di, itv):
            print(
                f"DEBUG-SCHED: Faculty {fid} REJECTS section {sid} interval {itv} "
                f"(day {di}) due to STRICT preference rule."
            )
            return False
        else:
            print(
                f"DEBUG-SCHED: Faculty {fid} ACCEPTS section {sid} interval {itv} "
                f"(day {di}) via preference rule."
            )

        # Conflicts (same day overlap)
        existing = grid.get(fid, {}).get(di, [])
        for cur in existing:
            if _conflict(cur, itv):
                print(
                    f"DEBUG-SCHED: Faculty {fid} REJECTS section {sid} interval {itv} "
                    f"due to CONFLICT with {cur}."
                )
                return False

        # 4.5-hour streak rule
        if not _streak_ok_for_day(existing, [itv]):
            print(
                f"DEBUG-SCHED: Faculty {fid} REJECTS section {sid} interval {itv} "
                f"due to 4.5-HOUR STREAK violation."
            )
            return False

    # All good
    return True

def _swap_assign(assignments: list[dict], sid: str, new_fid: str, new_name: str) -> list[dict]:
    # replace or insert assignment for sid
    out = []
    replaced = False
    for a in assignments:
        if a.get("section_id") == sid:
            out.append({**a, "faculty_id": new_fid, "faculty": new_name, "status": "Pending"})
            replaced = True
        else:
            out.append(a)
    if not replaced:
        out.append({"section_id": sid, "course_id": "", "faculty_id": new_fid, "faculty": new_name, "status":"Pending"})
    return out

def run_pass_ft_reclaim_from_pt(ctx, assignments: list[dict]) -> list[dict]:
    """
    Lift under-cap FTs by reclaiming PT-held sections when feasible.
    Never evict a solo-CMPS0002 PT from a CMPS0002 section.
    Limit: at most 1 reclaim per FT.
    """
    # compute units per course once
    units = {cid: int((ctx.courses.get(cid) or {}).get("units") or 3) for cid in ctx.courses}
    # tally FT usage
    used = {}
    for a in assignments:
        fid = a.get("faculty_id"); cid = a.get("course_id")
        if fid and cid:
            used[fid] = used.get(fid, 0) + units.get(cid, 3)
    caps = _faculty_capacities(ctx)

    # PT-held sections list
    pt_sections = [a for a in assignments if a.get("faculty_id") and _is_pt(ctx, a["faculty_id"])]

    for fdoc in ctx.faculty:
        fid = fdoc.get("faculty_id") or ""
        if not fid or not _is_ft(ctx, fid):
            continue
        # skip if FT already at or above cap
        if used.get(fid, 0) >= caps.get(fid, 0):
            continue

        # try reclaim one PT-held section that fits this FT
        for a in pt_sections:
            sid = a.get("section_id"); pfid = a.get("faculty_id")
            cid = a.get("course_id")

            # protect solo-CMPS0002 PT on CMPS0002
            if _is_solo_campus2_pref(ctx, pfid) and _section_campus(ctx, sid) == "CMPS0002":
                continue

            if not _kac_ok(ctx, fid, cid):
                continue
            if not _campus_mode_ok_ctx(ctx, fid, sid):
                continue
            if not _sched_ok_ctx(ctx, fid, sid, assignments):
                continue

            # perform swap (FT takes over)
            name = _display_name_from_users(ctx.users_by_faculty.get(fid))
            assignments = _swap_assign(assignments, sid, fid, name)

            # update tallies
            used[fid] = used.get(fid, 0) + units.get(cid, 3)
            # one reclaim per FT
            break

    return assignments

def run_pass_campus_concentrate_cmps2(ctx, assignments: list[dict]) -> list[dict]:
    """
    Move CMPS0002 sections from dual-campus FTs to PT(HYB & solo-CMPS0002) or PT(FOL),
    when feasible. Limit 1 move per FT, keep protections/time/KAC/mode.
    """
    # map faculty → campuses currently held
    by_fac = {}
    for a in assignments:
        fid = a.get("faculty_id"); sid = a.get("section_id")
        if fid and sid:
            by_fac.setdefault(fid, set()).add(_section_campus(ctx, sid))

    for ft in ctx.faculty:
        fid = ft.get("faculty_id") or ""
        if not fid or not _is_ft(ctx, fid):
            continue
        campuses = by_fac.get(fid, set())
        # only consider FTs with mixed campuses
        if not ({"CMPS0001", "CMPS0002"} <= (campuses | {""}) or ("CMPS0001" in campuses and "CMPS0002" in campuses)):
            continue

        # try to move one CMPS0002 section
        for a in [x for x in assignments if x.get("faculty_id") == fid]:
            sid = a.get("section_id")
            if _section_campus(ctx, sid) != "CMPS0002":
                continue
            cid = a.get("course_id")

            # candidate PT pool: solo-CMPS0002 & HYB, or FOL (campus-agnostic)
            pt_pool = [p for p in ctx.faculty if _is_pt(ctx, p.get("faculty_id") or "")]
            pt_pool = [p for p in pt_pool
                       if (_is_solo_campus2_pref(ctx, p["faculty_id"]) and _mode_of_pref(ctx, p["faculty_id"]) == "HYB")
                       or (_mode_of_pref(ctx, p["faculty_id"]) == "FOL")]

            found = None
            for p in pt_pool:
                pfid = p["faculty_id"]
                if not _kac_ok(ctx, pfid, cid):
                    continue
                if not _campus_mode_ok_ctx(ctx, pfid, sid):
                    continue
                if not _sched_ok_ctx(ctx, pfid, sid, assignments):
                    continue
                found = pfid
                break

            if found:
                name = _display_name_from_users(ctx.users_by_faculty.get(found))
                assignments = _swap_assign(assignments, sid, found, name)
                # one move per FT
                break

    return assignments

def run_pass_rescue_non_shs(ctx, assignments: list[dict]) -> list[dict]:
    """
    After 6A/6B(+D2), if any non-SHS sections are blank:
      • try a single atomic swap: move a compatible SHS-holding faculty to the blank,
      • PREFER a safe backfill for the released SHS,
      • but if POLICY_ALLOW_SHS_SACRIFICE_IF_NO_CAPACITY and no global capacity is left,
        allow sacrificing the SHS (leave it blank) as long as donor stays within cap.

    Gates enforced: campus+mode, KAC, time/prefs, capacity.
    """
    # quick lookups
    section_to_course = {s["section_id"]: s["course_id"] for s in ctx.sections}
    assigned_by_sid = {a["section_id"]: a for a in assignments if a.get("faculty_id")}
    all_sids = [s["section_id"] for s in ctx.sections]

    def _dbg(msg: str) -> None:
        print(f"[RESCUE_NON_SHS] {msg}")

    def _ctype(cid: str) -> str:
        c = (ctx.courses.get(cid) or {})
        t = (c.get("type") or c.get("type_of_course") or "Major")
        return str(t).strip().upper()

    # units and caps
    units = {cid: int((ctx.courses.get(cid) or {}).get("units") or 3) for cid in ctx.courses}
    used: dict[str, int] = {}
    for a in assignments:
        fid, cid = a.get("faculty_id"), a.get("course_id")
        if fid and cid:
            used[fid] = used.get(fid, 0) + units.get(cid, 3)
    caps = _faculty_capacities(ctx)

    # helpers (reuse existing policy guards)
    def _can_take(fid: str, sid: str) -> bool:
        cid = section_to_course.get(sid, "")
        used_now = used.get(fid, 0)
        cap = caps.get(fid, 0)
        extra = units.get(cid, 3)

        # NOTE: these logs fire for both donors and backfillers
        if not _kac_ok(ctx, fid, cid):
            print(f"[RESCUE_CAN_TAKE] fid={fid} sid={sid} ({cid}) -> False (KAC)")
            return False
        if not _campus_mode_ok_ctx(ctx, fid, sid):
            print(f"[RESCUE_CAN_TAKE] fid={fid} sid={sid} ({cid}) -> False (campus/mode)")
            return False
        if not _sched_ok_ctx(ctx, fid, sid, assignments):
            print(f"[RESCUE_CAN_TAKE] fid={fid} sid={sid} ({cid}) -> False (schedule)")
            return False
        if used_now + extra > cap:
            print(
                f"[RESCUE_CAN_TAKE] fid={fid} sid={sid} ({cid}) -> False (capacity) "
                f"used={used_now} extra={extra} cap={cap}"
            )
            return False

        print(
            f"[RESCUE_CAN_TAKE] fid={fid} sid={sid} ({cid}) -> True "
            f"used={used_now} extra={extra} cap={cap}"
        )
        return True

    _dbg(f"assignments={len(assignments)}")
    _dbg(f"used_units={used}")
    _dbg(f"caps={caps}")
    _dbg(f"total_remaining_capacity={_total_remaining_capacity(ctx, assignments)}")

    def _swap(assignments, sid_take, fid_take, name_take, sid_release, fid_release, name_backfill):
        # assign donor to blank
        assignments = [a for a in assignments if a.get("section_id") != sid_take] + [{
            "section_id": sid_take,
            "course_id": section_to_course.get(sid_take, ""),
            "faculty_id": fid_take,
            "faculty": name_take,
            "status": "Pending",
        }]
        # backfill the released SHS
        assignments = [a for a in assignments if a.get("section_id") != sid_release] + [{
            "section_id": sid_release,
            "course_id": section_to_course.get(sid_release, ""),
            "faculty_id": fid_release,
            "faculty": name_backfill,
            "status": "Pending",
        }]
        return assignments

    # 0) Inspect all sections from the rescue pass perspective
    _dbg("scanning all sections for blanks:")
    for sid in all_sids:
        cid = section_to_course.get(sid)
        ctype = _ctype(cid) if cid else "?"
        a = assigned_by_sid.get(sid)
        fid = a.get("faculty_id") if a else None
        status = (a.get("status") if a else None) or "None"
        _dbg(f"  sid={sid} cid={cid} type={ctype} faculty_id={fid} status={status}")


    # 1) list non-SHS blanks
    blanks = []
    for sid in all_sids:
        cid = section_to_course.get(sid)
        if not cid or _ctype(cid) == "SHS":
            continue
        a = assigned_by_sid.get(sid)
        if not a or (a.get("status", "").lower() in ("unassigned", "conflict")):
            blanks.append(sid)

    _dbg(f"non-SHS blanks={[(sid, section_to_course.get(sid, '')) for sid in blanks]}")

    if not blanks:
        _dbg("no non-SHS blanks, nothing to rescue")
        return assignments

    # 2) SHS donor pool
    shs_pool = [
        a for a in assignments
        if a.get("faculty_id") and _ctype(section_to_course.get(a["section_id"])) == "SHS"
    ]
    _dbg(f"SHS donor pool={[(a.get('section_id'), a.get('faculty_id')) for a in shs_pool]}")


    # 3) fix each blank with one atomic swap
    for sid_blank in blanks:
        cid_blank = section_to_course.get(sid_blank, "")
        _dbg(f"--- Trying to rescue blank {sid_blank} ({cid_blank}) ---")

        # best: dict | None = None  # pick the “safest” option among feasible swaps
        best = None  # pick the “safest” option among feasible swaps
        for shs_a in shs_pool:
            donor_fid = shs_a.get("faculty_id")
            shs_sid   = shs_a.get("section_id")
            if not donor_fid or not shs_sid:
                continue
            if donor_fid in (getattr(ctx, "leave_blocked", set()) or set()):
                _dbg(f"skip donor {donor_fid} (leave_blocked) on SHS {shs_sid}")
                continue

            # donor must be able to take the non-SHS blank (KAC/campus/mode/time),
            # but we ignore capacity here and check net load after swap instead.
            _dbg(f"check donor {donor_fid} from SHS {shs_sid} for blank {sid_blank}")
            # donor must be able to take the non-SHS blank
            if not _can_take(donor_fid, sid_blank):
                _dbg(f"  donor {donor_fid} CANNOT take blank {sid_blank} (see RESCUE_CAN_TAKE above)")
                continue

            shs_cid = section_to_course.get(shs_sid, "")

            # --- Try to find an immediate backfill for this SHS ---
            cinfo = (getattr(ctx, "by_course_for_rescue", {}) or {}).get(shs_cid) \
                    or {}  # optional: attach by_course to ctx if you like
            cand_list = list(cinfo.get("candidates", [])) or []

            # If you don't have by_course on ctx, fall back to all faculty:
            if not cand_list:
                cand_list = [{"faculty_id": f.get("faculty_id")} for f in ctx.faculty]

            backfill_fids = [
                c.get("faculty_id") for c in cand_list
                if c.get("faculty_id") and c.get("faculty_id") != donor_fid
            ]
            # PTs first
            backfill_fids = sorted(      
                backfill_fids,
                key=lambda fid: 0 if _is_pt(ctx, fid) else 1
            )

            # 🔍 DEBUG: see who we will even try as backfill
            _dbg(
                f"  potential backfills for SHS {shs_sid} ({shs_cid}) "
                f"donor={donor_fid}: {backfill_fids}"
            )

            bf: str | None = None
            for fid2 in backfill_fids:
                if fid2 in (getattr(ctx, "leave_blocked", set()) or set()):
                    _dbg(f"    skip backfill {fid2} (leave_blocked)")
                    continue

                _dbg(f"    try backfill {fid2} for SHS {shs_sid}")
                # Backfill must pass full feasibility (including capacity)
                if not _can_take(fid2, shs_sid):
                    _dbg(f"      backfill {fid2} CANNOT take SHS {shs_sid} (see RESCUE_CAN_TAKE above)")
                    continue

                _dbg(f"      backfill {fid2} OK for SHS {shs_sid}")
                bf = fid2
                break

            # compute current global remaining capacity once per donor
            no_capacity_left = (_total_remaining_capacity(ctx, assignments) == 0)
            _dbg(
                f"  after donor/backfill scan for donor {donor_fid} on SHS {shs_sid}: "
                f"bf={bf}, no_capacity_left={no_capacity_left}"
            )


            blank_ud = units.get(cid_blank, 3)
            shs_ud   = units.get(shs_cid, 3)
            donor_current = used.get(donor_fid, 0)
            donor_post = donor_current - shs_ud + blank_ud

            # If donor would exceed their cap after swapping, skip this donor entirely
            if donor_post > caps.get(donor_fid, 0):
                continue

            if bf is None:
                # --- SACRIFICE MODE: only allowed if everyone is maxed ---
                if not (POLICY_ALLOW_SHS_SACRIFICE_IF_NO_CAPACITY and no_capacity_left):
                    continue

                # Treat sacrifice as a worse rank than any safe backfill
                rank = (2, 0)
                if (best is None) or (rank < best["rank"]):
                    best = {
                        "rank": rank,
                        "donor_fid": donor_fid,
                        "donor_name": _display_name_from_users(ctx.users_by_faculty.get(donor_fid)),
                        "sid_shs": shs_sid,
                        "backfill_fid": None,
                        "backfill_name": "",
                        "donor_post": donor_post,
                    }
                continue  # check other donors

            # --- Normal case: we DO have a backfill ---
            pt_pref = 0 if _is_pt(ctx, bf) else 1
            conc_nudge = 0
            if _section_campus(ctx, shs_sid) == "CMPS0002" and _is_pt(ctx, bf) and _is_solo_campus2_pref(ctx, bf):
                conc_nudge = -1
            rank = (pt_pref, conc_nudge)

            if (best is None) or (rank < best["rank"]):
                best = {
                    "rank": rank,
                    "donor_fid": donor_fid,
                    "donor_name": _display_name_from_users(ctx.users_by_faculty.get(donor_fid)),
                    "sid_shs": shs_sid,
                    "backfill_fid": bf,
                    "backfill_name": _display_name_from_users(ctx.users_by_faculty.get(bf)),
                    "donor_post": donor_post,
                }

        if best:
            _dbg(
                f"==> RESCUED {sid_blank} using donor={best['donor_fid']} "
                f"from SHS={best['sid_shs']} backfill={best.get('backfill_fid')}"
            )
        else:
            _dbg(f"==> FAILED to rescue blank {sid_blank}: no feasible donor+backfill combo")

        
        # Apply chosen move (if any) for this blank
        if best:
            donor_fid   = best["donor_fid"]
            donor_name  = best["donor_name"]
            shs_sid     = best["sid_shs"]
            shs_cid     = section_to_course.get(shs_sid, "")
            shs_units   = units.get(shs_cid, 3)
            blank_units = units.get(cid_blank, 3)

            if best["backfill_fid"]:
                # normal atomic swap (donor -> blank, backfill -> SHS)
                bf = best["backfill_fid"]
                bf_name = best["backfill_name"]
                assignments = _swap(
                    assignments,
                    sid_blank, donor_fid, donor_name,
                    shs_sid, bf, bf_name,
                )
                # update usage tallies
                used[donor_fid] = used.get(donor_fid, 0) - shs_units + blank_units
                used[bf]        = used.get(bf, 0) + shs_units
            else:
                # --- SACRIFICE MODE: move donor to blank and leave SHS unassigned ---
                # 1) remove donor's SHS assignment
                assignments = [a for a in assignments if a.get("section_id") != shs_sid]
                # 2) assign donor to blank
                assignments = [a for a in assignments if a.get("section_id") != sid_blank] + [{
                    "section_id": sid_blank,
                    "course_id": cid_blank,
                    "faculty_id": donor_fid,
                    "faculty": donor_name,
                    "status": "Pending",
                }]
                # 3) adjust donor usage (−SHS + blank)
                used[donor_fid] = used.get(donor_fid, 0) - shs_units + blank_units

            # donor’s former SHS is no longer in donor pool
            shs_pool = [a for a in shs_pool if a.get("section_id") != shs_sid]

    _dbg("end of run_pass_rescue_non_shs")
    return assignments

# =============  MILESTONE E — Phase 7 (SHS soft-locks + Proposed Times)  =============
async def run_milestone_e_phase7(term_id: str, db, department_id: str | None = None) -> dict:
    """
    Builds on Phase 6B results.
    - Treat SHS sections the same as other sections (no soft-lock).
    - For sections with no schedule, propose day/time based on faculty prefs.
      (We do not persist; we only surface proposed times in the assignment payload.)
    """
    base = await run_milestone_d2_rebalance_shs_to_cover_nshs(term_id, db, department_id)
    assignments = list(base.get("assignments", []))

    # ---------------- PRE-CAP CONTEXT + DEBUG SHELL ----------------
    ctx = await phase0_load(term_id, db, department_id)
    dbg_prev = dict(base.get("debug", {}) or {})

    # --- HARD STOP: CAP PRUNE IMMEDIATELY AFTER D2 ---
    # This ensures:
    #   • D2 rebalances can overshoot caps a bit,
    #   • but we prune *once* here,
    #   • and all later passes (rescue / reclaim / concentrate) see the
    #     real blanks and respect caps.
    print("[CAP_ENFORCE] incoming_assignments:", len(assignments))
    assignments, used_units = _enforce_global_caps(ctx, assignments)
    print("[CAP_ENFORCE] assignments_after_prune:", len(assignments))
    print("[CAP_ENFORCE] used_units_after:", used_units)

    cap_dbg = dbg_prev.setdefault("cap_sanity", {})
    cap_dbg["assignments_after_prune"] = len(assignments)
    cap_dbg["used_units_by_faculty"] = {fid: int(u) for fid, u in used_units.items()}

    # ---------------- MICRO-PASSES ON TOP OF PRUNED SET -------------
    # 0) rescue pass: ensure no Major/Foundation/Other stays blank while SHS is filled
    assignments = run_pass_rescue_non_shs(ctx, assignments)

    # 1) optional: FT-first reclaim (keeps SHS+rules & caps)
    assignments = run_pass_ft_reclaim_from_pt(ctx, assignments)

    # 2) optional: improve CMPS0002 concentration (keeps rules; we keep loads balanced)
    assignments = run_pass_campus_concentrate_cmps2(ctx, assignments)

    def _section_campus(ctx, section_id: str) -> str:
        for sec in (ctx.sections or []):
            if sec.get("section_id") == section_id:
                return str(sec.get("campus_id") or "")
        return ""


    # From here down, we only propose times and don’t change who teaches what.
    # Rebuild context for schedules / types (separate from capacity ctx above).
    courses_ctx = await phase0_load(term_id, db, department_id)
    courses = courses_ctx.courses
    schedules_by_section = courses_ctx.schedules_by_section or {}
    fac_prefs = courses_ctx.prefs_by_faculty or {}
    sections_by_id = {s["section_id"]: s for s in courses_ctx.sections}

    campus_blocked = getattr(courses_ctx, "campus_blocked", {}) or {}

    # Inverse map of day_int -> day_code (1->'M', etc.)
    INV_DAY_MAP = {v: k for k, v in _DAY_MAP.items()}

    def _all_pref_windows(fp: dict) -> list[tuple[int, int]]:
        """
        Return *all* usable preferred windows for a faculty as minute pairs.
        Mirrors _first_window but returns a list instead of just one.
        """
        times = (fp or {}).get("preferred_times")
        if not times:
            return []
        seq = times if isinstance(times, list) else [times]
        out: list[tuple[int, int]] = []
        for t in seq:
            st = en = None
            if isinstance(t, dict):
                st = _to_min(t.get("start") or t.get("begin"))
                en = _to_min(t.get("end")   or t.get("finish"))
            elif isinstance(t, (list, tuple)) and len(t) == 2:
                st, en = _to_min(t[0]), _to_min(t[1])
            elif isinstance(t, str):
                s = (
                    t.replace("–", "-")
                     .replace("—", "-")
                     .replace("―", "-")
                     .replace("‒", "-")
                     .strip()
                     .upper()
                )
                if "-" in s:
                    a, b = s.split("-", 1)
                    st, en = _to_min(a), _to_min(b)
                else:
                    buckets = {
                        "AM": (0, 12 * 60), "PM": (12 * 60, 24 * 60),
                        "MORNING": (6 * 60, 12 * 60), "AFTERNOON": (12 * 60, 18 * 60),
                        "EVENING": (17 * 60, 21 * 60), "NIGHT": (21 * 60, 24 * 60),
                    }
                    if s in buckets:
                        st, en = buckets[s]
            else:
                continue

            if st is not None and en is not None and st >= 0 and en > st:
                out.append((st, en))
        return out

    def _build_faculty_slot_pool(
        prefs: dict[str, dict]
    ) -> dict[str, list[dict]]:
        """
        Build a pool of (day1, day2, st, en) slots per faculty, based on:
          - availability_days
          - preferred_times

        Day buckets are still grouped as (M/H), (T/F), (W/S), but:
          - If BOTH days of the pair are available -> slot is (anchor, mate) (e.g. T/F).
          - If ONLY ONE day is available       -> slot is that single day, day2=None.
        """
        pair = {"M": "H", "T": "F", "W": "S"}  # group buckets
        pool: dict[str, list[dict]] = {}

        for fid, fp in (prefs or {}).items():
            days = (fp or {}).get("availability_days") or []
            norm_days: list[str] = []
            for d in days:
                s = str(d).strip().upper()
                if s == "TH":
                    s = "H"
                if s in ("M", "T", "W", "H", "F", "S"):
                    norm_days.append(s)
            day_set = set(norm_days)

            # collect usable "buckets" (M/H, T/F, W/S) if at least one day is present
            buckets: list[list[str]] = []
            for anchor, mate in pair.items():
                has_anchor = anchor in day_set
                has_mate = mate in day_set
                if not (has_anchor or has_mate):
                    continue  # this bucket is not available at all

                actual_days: list[str] = []
                if has_anchor:
                    actual_days.append(anchor)
                if has_mate:
                    actual_days.append(mate)

                # actual_days is now:
                #   - [anchor, mate] if both picked (e.g. ["T","F"])
                #   - [anchor]       if only anchor
                #   - [mate]         if only mate
                buckets.append(actual_days)

            if not buckets:
                continue  # no usable day buckets

            wins = _all_pref_windows(fp)
            if not wins:
                continue  # no usable time windows

            slots: list[dict] = []
            for day_list in buckets:
                for st, en in wins:
                    if len(day_list) == 2:
                        d1, d2 = day_list[0], day_list[1]
                    else:
                        d1, d2 = day_list[0], None  # single-day slot

                    slots.append({"day1": d1, "day2": d2, "st": st, "en": en})

            if slots:
                pool[fid] = slots
                print(
                    f"DEBUG-SLOT-POOL: faculty {fid} has {len(slots)} "
                    f"slots from buckets={buckets} windows={wins}"
                )
                # Detailed breakdown of each concrete slot
                for s in slots:
                    d1 = s["day1"]
                    d2 = s["day2"]
                    st = s["st"]
                    en = s["en"]
                    b_str = _mm_to_hhmm(st)
                    e_str = _mm_to_hhmm(en)
                    if d2:
                        day_repr = f"{d1}/{d2}"
                    else:
                        day_repr = d1
                    print(
                        f"DEBUG-SLOT-POOL-DETAIL: faculty {fid} slot "
                        f"{day_repr} {b_str}-{e_str}"
                    )

        return pool

    # Build in-memory slot pool: fid -> list of concrete (day1, day2, st, en)
    faculty_slot_pool = _build_faculty_slot_pool(fac_prefs)

    print("DEBUG-SLOT-POOL-SUMMARY: ============================")
    for fid, slots in faculty_slot_pool.items():
        combos = []
        for s in slots:
            b = _mm_to_hhmm(s["st"])
            e = _mm_to_hhmm(s["en"])
            combos.append(f"{s['day1']}/{s['day2']} {b}-{e}")
        print(f"DEBUG-SLOT-POOL-SUMMARY: {fid} -> {combos}")
    print("DEBUG-SLOT-POOL-SUMMARY: ============================")

    # Track existing intervals per faculty/day from already-scheduled sections
    faculty_day_intervals: dict[str, dict[str, list[tuple[int, int]]]] = {}
    for a in assignments:
        fid = a.get("faculty_id")
        sid = a.get("section_id")
        if not fid or not sid:
            continue
        slots = _slots_from_scheds(schedules_by_section.get(sid, []))
        for di, (st, en) in slots:
            day_code = INV_DAY_MAP.get(di)
            if not day_code:
                continue
            faculty_day_intervals.setdefault(fid, {}).setdefault(day_code, []).append((st, en))


    def _is_blocked_ge_cmps2_slot(sid: str, di: int, interval: tuple[int, int]) -> bool:
        """
        Owner-scoped blocking:
        A CMPS0002 GE blocked window only blocks sections that share the same
        (owner_program_id, owner_batch_id).
        """
        sec = sections_by_id.get(sid, {})
        campus = (sec.get("campus_id") or "").strip().upper()
        if campus != "CMPS0002":
            return False

        cid = (sec.get("course_id") or "").strip()
        c = (courses.get(cid) or {})
        ttype = str(c.get("type_of_course") or c.get("type") or "").strip().upper()
        if ttype != "GE":
            return False

        owner_key = (
            (sec.get("owner_program_id") or None),
            (sec.get("owner_batch_id") or None),
        )

        # campus_blocked structure (from your updated phase0_load):
        # campus_blocked["CMPS0002"][owner_key][day_idx] -> [(st,en,section_id,course_id,section_code), ...]
        by_owner = (campus_blocked.get("CMPS0002") or {})
        day_map = (by_owner.get(owner_key) or {})
        blocked_arr = day_map.get(di, [])

        st, en = interval
        for bst, ben, *_rest in blocked_arr:
            if not (en <= bst or st >= ben):  # overlap
                return True
        return False

    def _course_is_shs(cid: str) -> bool:
        t = (courses.get(cid) or {}).get("type") or (courses.get(cid) or {}).get("type_of_course")
        return str(t).strip().upper() == "SHS"

    def _first_window(fp: dict) -> tuple[int,int] | None:
        """Pick the first usable preferred time window from prefs (strings, pairs, or dicts)."""
        times = (fp or {}).get("preferred_times")
        if not times:
            return None
        seq = times if isinstance(times, list) else [times]
        for t in seq:
            if isinstance(t, dict):
                st = _to_min(t.get("start") or t.get("begin"))
                en = _to_min(t.get("end")   or t.get("finish"))
            elif isinstance(t, (list, tuple)) and len(t) == 2:
                st, en = _to_min(t[0]), _to_min(t[1])
            elif isinstance(t, str):
                s = t.strip().upper().replace("\u2013", "-").replace("\u2014", "-")
                if "-" in s:
                    a, b = s.split("-", 1)
                    st, en = _to_min(a), _to_min(b)
                else:
                    # bucket keywords
                    buckets = {
                        "AM": (0, 12*60), "PM": (12*60, 24*60),
                        "MORNING": (6*60, 12*60), "AFTERNOON": (12*60, 18*60),
                        "EVENING": (17*60, 21*60), "NIGHT": (21*60, 24*60),
                    }
                    if s in buckets:
                        st, en = buckets[s]
                    else:
                        continue
            else:
                continue
            if st >= 0 and en > st:
                return (st, en)
        return None

    def _pick_days(fp: dict) -> tuple[str, str]:
        """Return paired days with directional order: day1 in {M,T,W} only; day2 = {H,F,S}."""
        pair = {"M":"H","T":"F","W":"S"}  # directional
        days = (fp or {}).get("availability_days") or []
        norm = []
        for d in days:
            s = str(d).strip().upper()
            if s == "TH": s = "H"
            if s in ("M","T","W","H","F","S"):
                norm.append(s)
        # pick first available anchor from M,T,W; else default M/H
        for anchor in ("M","T","W"):
            if anchor in norm:
                return (anchor, pair[anchor])
        return ("M", "H")

    # Build proposed times for sections that lack schedules ------------------
    proposed: list[dict] = []
    kept: list[dict] = []

     # NEW: collect reasons when a section ends with no proposed times (DEBUG)
    debug_no_time_phase7: dict[str, dict] = {}  # section_id -> reasons

    for a in assignments:
        sid = a["section_id"]; cid = a["course_id"]; fid = a["faculty_id"]
        has_sched = any(_slots_from_scheds(schedules_by_section.get(sid, [])))
        if has_sched:
            kept.append(a)
            # NEW: explain that we skipped because a schedule already exists (DEBUG)
            debug_no_time_phase7[sid] = {"reason": "has_existing_schedule"}
            continue

        # Use STRICT slot pool: only precomputed faculty slots, no grid.
        fp = fac_prefs.get(fid)
        if not fp:
            kept.append(a)
            debug_no_time_phase7[sid] = {
                "reason": "no_prefs_for_faculty_in_phase7",
                "faculty_id": fid,
            }
            continue

        pool = faculty_slot_pool.get(fid, [])
        if not pool:
            kept.append(a)
            debug_no_time_phase7[sid] = {
                "reason": "no_slot_pool_for_faculty",
                "faculty_id": fid,
                "pref_snapshot": {
                    "availability_days": (fp or {}).get("availability_days"),
                    "preferred_times": (fp or {}).get("preferred_times"),
                },
            }
            continue

        # Try to pick ONE usable slot from this faculty's pool
        chosen_idx: int | None = None
        chosen_slot: dict | None = None

        for idx, slot in enumerate(pool):
            d1 = slot["day1"]
            d2 = slot["day2"]
            st = slot["st"]
            en = slot["en"]

            # Avoid CMPS0002 GE blocked windows
            di1 = _DAY_MAP.get(d1, _DAY_MAP.get(d1[:1], -1)) if d1 else -1
            di2 = _DAY_MAP.get(d2, _DAY_MAP.get(d2[:1], -1)) if d2 else -1
            interval = (st, en)

            if (di1 > 0 and _is_blocked_ge_cmps2_slot(sid, di1, interval)) or \
               (di2 > 0 and _is_blocked_ge_cmps2_slot(sid, di2, interval)):
                continue  # try next slot

            # Enforce 4.5h streak rule per day
            day_ints = faculty_day_intervals.setdefault(fid, {})
            existing_d1 = day_ints.get(d1, [])
            existing_d2 = day_ints.get(d2, [])

            if not _streak_ok_for_day(existing_d1, [(st, en)]):
                continue
            if not _streak_ok_for_day(existing_d2, [(st, en)]):
                continue

            chosen_idx = idx
            chosen_slot = {"day1": d1, "day2": d2, "st": st, "en": en}
            break

        if chosen_slot is None:
            # IMPORTANT:
            # We DO NOT keep this assignment anymore.
            # This means the faculty cannot be assigned to this section
            # because no compatible slot exists (prefs / 4.5h rule / conflicts).
            debug_no_time_phase7[sid] = {
                "reason": "no_free_slot_from_pool",
                "faculty_id": fid,
                "pref_snapshot": {
                    "availability_days": (fp or {}).get("availability_days"),
                    "preferred_times": (fp or {}).get("preferred_times"),
                },
            }
            # don't append `a` to kept -> effectively "unassign" this section in Phase 7
            continue

        # Consume the chosen slot from the pool (so it can't be reused)
        pool.pop(chosen_idx)
        faculty_slot_pool[fid] = pool

        d1 = chosen_slot["day1"]
        d2 = chosen_slot["day2"]
        st = chosen_slot["st"]
        en = chosen_slot["en"]

        # Compatibility w/ OM_LoadAssignment v1 UI expectations:
        # The Load Assignment grid treats the schedule as a paired-day pattern
        # (M/H, T/F, W/S). Some preference inputs can yield a "single-day" slot
        # (day2 is None) which leaves Day 2/Begin 2/End 2 blank after auto-assign.
        # To match v1 behavior, auto-fill a paired Day 2 when we have Day 1.
        #
        # We only do this inside Phase 7 (auto-proposed times for sections that
        # have no registered section_schedules) so we don't mutate true one-day
        # schedules coming from the registrar.
        if d1 and not d2:
            try:
                d2 = DAY_PAIR.get(str(d1).upper().strip())
            except Exception:
                d2 = None

        # Update faculty's day-wise intervals (for streak checks later)
        day_ints = faculty_day_intervals.setdefault(fid, {})
        if d1:
            day_ints.setdefault(d1, []).append((st, en))
        if d2:
            day_ints.setdefault(d2, []).append((st, en))

        # Inject the proposed schedule into the assignment
        assn = dict(a)
        if d1:
            assn["day1"] = d1
            assn["begin1"] = _mm_to_hhmm(st)
            assn["end1"]   = _mm_to_hhmm(en)
        if d2:
            assn["day2"] = d2
            assn["begin2"] = _mm_to_hhmm(st)
            assn["end2"]   = _mm_to_hhmm(en)

        proposed.append(assn)

    final_assignments = kept + proposed

    debug7 = {
        "phase7_proposed_count": len(proposed),
        "phase7_kept_count": len(kept),
        "phase7_note": "Proposed times based on availability_days/preferred_times for unscheduled, non-SHS sections.",
        "phase7_no_time_details": debug_no_time_phase7,
    }

    return {
        **base,
        "assignments": final_assignments,
        "debug": {**dbg_prev, **debug7},
    }

# =============  END MILESTONE E — Phase 7  ==========================

async def _approve_and_persist(term_id: str, rows: list[dict], db):
    """
    For each approved row:
      - Upsert faculty_assignments(term_id, section_id) -> faculty_id, course_id, status='Confirmed'
      - Upsert section_schedules (non-SHS only) from day/begin/end pairs
    Idempotent: same keys will be overwritten, not duplicated.
    """
    # Load context once (course types, existing schedules, section→course map, etc.)
    ctx = await phase0_load(term_id, db, department_id=None)
    section_to_course = {s["section_id"]: s["course_id"] for s in ctx.sections}

    # quick course-type checker
    def _course_is_shs(cid: str) -> bool:
        t = (ctx.courses.get(cid) or {}).get("type") or (ctx.courses.get(cid) or {}).get("type_of_course")
        return str(t).strip().upper() == "SHS"

    # Build a dict from section_id -> (faculty_id, course_id) using the latest compute run
    sugg = await compute_load_recommendations(term_id=term_id, db=db, department_id=department_id, protected_section_ids=locked_section_ids)
    by_sid = {a["section_id"]: a for a in (sugg.get("assignments") or [])}

    # --- NEW: preflight used slots to prevent duplicates across the batch ---
    used: dict[str, set[tuple[str,str,str]]] = {}

    def _add_used(fid: str | None, d: str | None, b: str | None, e: str | None):
        if not fid or not d or not b or not e:
            return
        used.setdefault(fid, set()).add((str(d).upper(), str(b), str(e)))

    def _dup(fid: str | None, d: str | None, b: str | None, e: str | None) -> bool:
        if not fid or not d or not b or not e:
            return False
        return (str(d).upper(), str(b), str(e)) in used.get(fid, set())

    # Process each approved row
    for r in rows:
        sid = r.get("id") or r.get("section_id")
        if not sid:
            continue
        a = by_sid.get(sid) or {}

        # Prefer the faculty manually chosen in the row; fall back to the latest compute suggestion.
        fid = r.get("faculty_id") or a.get("faculty_id")
        cid = a.get("course_id") or section_to_course.get(sid)

        # --- Allow SHS fallback: use the row faculty_id even if missing in compute output ---
        if not fid and _course_is_shs(cid):
            fid = r.get("faculty_id")

        # skip rows without an assigned faculty or those marked Conflict/Unassigned
        status = (r.get("status") or "Pending").capitalize()

        # --- NEW: keep sections.mode in sync with the row's mode (if present) ---
        row_mode = str(r.get("mode") or "").strip().upper()
        if row_mode:
            await db[COL_SECTIONS].update_one(
                {"section_id": sid},
                {"$set": {"mode": row_mode}},
                upsert=False,
            )

        # # Skip only if truly missing faculty (except SHS, which may show 'Unassigned')
        # if not fid:
        #     continue

        # # For non-SHS courses, skip if marked Conflict/Unassigned
        # if status in ("Conflict", "Unassigned") and not _course_is_shs(cid):
        #     continue
            
        allow_assignment = bool(fid)

        # ---------- 1) faculty_assignments upsert (preserve legacy; not archived) ----------
        # If there is already an assignment doc for this section (legacy or new schema),
        # update it in-place and KEEP its legacy fields (assignment_id, load_id).
        if allow_assignment:
            existing = await db[COL_ASSIGN].find_one(
                {"section_id": sid},
                {"_id": 0, "assignment_id": 1, "load_id": 1}
            )

            set_fields = {
                "section_id": sid,
                "faculty_id": fid,
                "course_id": cid,
                "term_id": term_id,
                "status": "Confirmed",
                "is_archived": False,
            }
            # Preserve legacy identifiers if present
            if existing and existing.get("assignment_id"):
                set_fields["assignment_id"] = existing["assignment_id"]
            if existing and existing.get("load_id"):
                set_fields["load_id"] = existing["load_id"]

            await db[COL_ASSIGN].update_one(
                {"section_id": sid},
                {"$set": set_fields},
                upsert=True,
            )

        # ---------- 2) section_schedules upsert ----------
        if not cid:
            continue

        # pull proposed times from the row (already normalized in UI/run)
        pairs = [("day1","begin1","end1",1),("day2","begin2","end2",2)]
        for dkey, bkey, ekey, ordn in pairs:
            day = (r.get(dkey) or "").strip().upper()
            begin_hhmm = _norm_hhmm(r.get(bkey))
            end_hhmm   = _norm_hhmm(r.get(ekey))
            if not day or not begin_hhmm or not end_hhmm:
                continue

            # duplicate-slot check only if we actually know the faculty
            if fid and _dup(fid, day, begin_hhmm, end_hhmm):
                continue
            
            schedule_id = _sched_id(sid, ordn)

            # Only update existing schedules; do NOT touch room_id / room_type and do NOT create new docs
            await db[COL_SCHED].update_one(
                {"schedule_id": schedule_id},
                {
                    "$set": {
                        # optional: you can also drop schedule_id here since it’s in the filter
                        "term_id": term_id,
                        "section_id": sid,
                        "day": day,
                        "start_time": _to_compact_hhmm(begin_hhmm),
                        "end_time": _to_compact_hhmm(end_hhmm),
                        "updated_at": r.get("updated_at") or _utcnow(),
                    }
                },
                upsert=False,  # <— no more creating section_schedules here
            )
            _add_used(fid, day, begin_hhmm, end_hhmm)

# for action = "save"
async def _persist_rows_no_auto(term_id: str, rows: list[dict], db):
    """
    Lightweight persister for SAVE DRAFT.

    - DOES NOT call compute_load_recommendations (no auto-assign).
    - Only persists what is explicitly present in the incoming rows:
      * sections.mode (from row['mode'], if any)
      * faculty_assignments (only if row['faculty_id'] is set)
      * section_schedules (from row day/begin/end + room1/room2)
    """
    # Load context once (course types, existing schedules, section→course map, etc.)
    ctx = await phase0_load(term_id, db, department_id=None)
    section_to_course = {s["section_id"]: s["course_id"] for s in ctx.sections}

    # NEW: seed for auto-created section_ids, e.g. SEC0042, SEC0043, ...
    next_section_seq = _next_section_seq_from_ctx(ctx)
    # next_section_seq computed from existing sections

    new_sections: set[str] = set()

    def _course_is_shs(cid: str | None) -> bool:
        if not cid:
            return False
        c = (ctx.courses.get(cid) or {})
        t = c.get("type") or c.get("type_of_course")
        return str(t or "").strip().upper() == "SHS"

    # --- Prevent duplicate slots within this SAVE batch (per faculty) ---
    used: dict[str, set[tuple[str, str, str]]] = {}

    def _add_used(fid: str | None, d: str | None, b: str | None, e: str | None) -> None:
        if not fid or not d or not b or not e:
            return
        used.setdefault(fid, set()).add((str(d).upper(), str(b), str(e)))

    def _dup(fid: str | None, d: str | None, b: str | None, e: str | None) -> bool:
        if not fid or not d or not b or not e:
            return False
        return (str(d).upper(), str(b), str(e)) in used.get(fid, set())

    for r in rows:
        sid = r.get("id") or r.get("section_id")
        if not sid:
            continue

        cid = section_to_course.get(sid)
        fid = r.get("faculty_id") or None

        # --- NEW: auto-create a real section if this sid is unknown ---
        if not cid:
            course_id = (r.get("course_id") or "").strip()
            course_code = (r.get("course") or "").strip()

            course_doc: dict[str, Any] | None = None
            if course_id:
                course_doc = await db[COL_COURSES].find_one(
                    {"course_id": course_id},
                    {"_id": 0, "course_id": 1, "units": 1},
                )
            elif course_code:
                course_doc = await db[COL_COURSES].find_one(
                    {"course_code": course_code},
                    {"_id": 0, "course_id": 1, "units": 1},
                )

            if not course_doc:
                print(
                    "[SAVE] skip row – cannot auto-create section for row id=",
                    r.get("id"),
                    "no matching course for course_id/course_code:",
                    course_id,
                    course_code,
                )
                # we don't know what course to attach to, skip this row entirely
                continue

            cid = course_doc["course_id"]

            # If OM entered a Units value for a manually-added row, prefer it.
            # Otherwise fall back to the course's default units.
            units_override = None
            try:
                uraw = r.get("units")
                if uraw is not None and str(uraw).strip() != "":
                    units_override = float(str(uraw).strip())
            except Exception:
                units_override = None

            # Generate a brand new section_id, e.g. SEC0042
            new_sid = f"SEC{next_section_seq:04d}"
            next_section_seq += 1

            now = _utcnow()
            sec_doc = {
                "section_id": new_sid,
                "term_id": term_id,
                "course_id": cid,
                "section_code": (r.get("section") or "").strip(),
                "units": units_override if units_override is not None else course_doc.get("units"),
                "enrollment_cap": r.get("capacity") or None,
                "campus_id": r.get("campus_id") or None,  # <-- ADD THIS
                "created_at": now,
                "updated_at": now,
            }

            await db[COL_SECTIONS].insert_one(sec_doc)
            print(
                "[SAVE] created new section:",
                {"section_id": new_sid, "course_id": cid, "term_id": term_id},
            )

            # Mark this as a newly created section in this SAVE
            new_sections.add(new_sid)

            # --- NEW: bootstrap faculty_assignment (even if faculty is still blank) ---
            fid_raw = (r.get("faculty_id") or "").strip()
            fa_doc = {
                "section_id": new_sid,
                "term_id": term_id,
                "course_id": cid,
                "faculty_id": fid_raw,                 # "" if none yet
                "is_archived": False,
                "status": r.get("status") or "Pending",
                "created_at": now,
            }
            await db[COL_ASSIGN].update_one(
                {"section_id": new_sid},
                {"$setOnInsert": fa_doc},
                upsert=True,
            )

            # --- NEW: bootstrap 2 empty section_schedules (SCHxxxx-01 / -02) ---
            for ordn in (1, 2):
                schedule_id = _sched_id(new_sid, ordn)
                sched_doc = {
                    "schedule_id": schedule_id,
                    "section_id": new_sid,
                    "term_id": term_id,
                    "day": "",
                    "start_time": "",
                    "end_time": "",
                    "room_id": "",
                    "room_type": "",
                    "created_at": now,
                    "updated_at": now,
                }
                await db[COL_SCHED].update_one(
                    {"schedule_id": schedule_id},
                    {"$setOnInsert": sched_doc},
                    upsert=True,
                )

            # Update local variables + mapping so the rest of this function uses the new id
            sid = new_sid
            r["id"] = new_sid
            r["section_id"] = new_sid
            section_to_course[sid] = cid


        # --- 0) Keep section mode/campus in sync with the row (if present) ---
        # IMPORTANT:
        # The OM grid is primarily sourced from `sections_submitted` via _fetch_rows().
        # If we only update `sections`, the Mode column can appear blank after a refresh/send.
        # Therefore, we update BOTH collections.
        row_mode = str(r.get("mode") or r.get("Mode") or "").strip().upper()
        if row_mode:
            await db[COL_SECTIONS].update_one(
                {"section_id": sid},
                {"$set": {"mode": row_mode, "updated_at": _utcnow()}},
                upsert=False,
            )

            # Best-effort: ensure the submitted snapshot reflects the same mode.
            # Use upsert so newly created sections (via SAVE) also become visible in the OM list.
            now = _utcnow()
            await db[COL_SECTIONS_SUBMITTED].update_one(
                {"term_id": term_id, "section_id": sid},
                {
                    "$set": {"mode": row_mode, "updated_at": now, "snapshot_at": now},
                    "$setOnInsert": {
                        "term_id": term_id,
                        "section_id": sid,
                        "course_id": cid,
                        "section_code": (r.get("section") or "").strip(),
                        "created_at": now,
                    },
                },
                upsert=True,
            )

        campus_id = (r.get("campus_id") or "").strip()
        if campus_id:
            now = _utcnow()
            await db[COL_SECTIONS].update_one(
                {"section_id": sid},
                {"$set": {"campus_id": campus_id, "updated_at": now}},
                upsert=False,
            )
            await db[COL_SECTIONS_SUBMITTED].update_one(
                {"term_id": term_id, "section_id": sid},
                {"$set": {"campus_id": campus_id, "updated_at": now, "snapshot_at": now}},
                upsert=True,
            )

        # ---------- 1) faculty_assignments upsert (persist drafts even if faculty is blank) ----------
        # We intentionally persist partial/blank inputs so drafts survive logout/login.
        # Safeguard: do not accidentally clear terminal assignments.
        fid_raw = (r.get("faculty_id") or "").strip()
        existing = await db[COL_ASSIGN].find_one(
            {"section_id": sid},
            {"_id": 0, "assignment_id": 1, "load_id": 1, "status": 1, "faculty_id": 1},
        ) or {}

        existing_fid = str(existing.get("faculty_id") or "").strip()

        # If OM edits a schedule row that is currently in "Approved" status,
        # the approval becomes stale and must be re-sent to faculty.
        # Automatically demote Approved → Pending and reset the faculty proposal to "proposed"
        # (without notifying yet; OM will send again).
        edit_resets_approval = False
        try:
            if str(existing.get("status") or "").strip().lower() == "approved":
                def _c(v: str) -> str:
                    return _to_compact_hhmm(_norm_hhmm(v) or "") if v else ""

                # Current DB schedules (best-effort)
                s1 = await db[COL_SCHED].find_one(
                    {"schedule_id": _sched_id(sid, 1)},
                    {"_id": 0, "day": 1, "start_time": 1, "end_time": 1},
                ) or {}
                s2 = await db[COL_SCHED].find_one(
                    {"schedule_id": _sched_id(sid, 2)},
                    {"_id": 0, "day": 1, "start_time": 1, "end_time": 1},
                ) or {}

                db_view = {
                    "faculty_id": existing_fid,
                    "day1": str(s1.get("day") or "").strip().upper(),
                    "begin1": str(s1.get("start_time") or "").strip(),
                    "end1": str(s1.get("end_time") or "").strip(),
                    "day2": str(s2.get("day") or "").strip().upper(),
                    "begin2": str(s2.get("start_time") or "").strip(),
                    "end2": str(s2.get("end_time") or "").strip(),
                }

                in_view = {
                    "faculty_id": fid_raw,
                    "day1": str(r.get("day1") or "").strip().upper(),
                    "begin1": _c(str(r.get("begin1") or "")),
                    "end1": _c(str(r.get("end1") or "")),
                    "day2": str(r.get("day2") or "").strip().upper(),
                    "begin2": _c(str(r.get("begin2") or "")),
                    "end2": _c(str(r.get("end2") or "")),
                }

                if db_view != in_view:
                    edit_resets_approval = True
        except Exception:
            edit_resets_approval = False

        if edit_resets_approval:
            now = _utcnow()
            # Ensure the persisted assignment becomes Pending
            r["status"] = "Pending"

            # Reset the faculty proposal row to the edited version and set proposal status back to "proposed"
            # so Faculty must accept again; previous approved version is replaced.
            def _norm_for_faculty(rr: dict) -> dict:
                out = dict(rr or {})
                out["course_code"] = (out.get("course_code") or out.get("course") or "").strip()
                out["course_title"] = (out.get("course_title") or out.get("title") or "").strip()

                b1 = str(out.get("start") or out.get("begin1") or "").strip()
                e1 = str(out.get("end") or out.get("end1") or "").strip()
                if b1 and re.fullmatch(r"\d{4}", b1):
                    b1 = f"{b1[:2]}:{b1[2:]}"
                if e1 and re.fullmatch(r"\d{4}", e1):
                    e1 = f"{e1[:2]}:{e1[2:]}"
                out["start"] = b1
                out["end"] = e1
                if b1 and e1:
                    out["time1"] = out.get("time1") or f"{b1}–{e1}"

                b2 = str(out.get("start2") or out.get("begin2") or "").strip()
                e2 = str(out.get("end2") or out.get("end2") or "").strip()
                if b2 and re.fullmatch(r"\d{4}", b2):
                    b2 = f"{b2[:2]}:{b2[2:]}"
                if e2 and re.fullmatch(r"\d{4}", e2):
                    e2 = f"{e2[:2]}:{e2[2:]}"
                out["start2"] = b2
                out["end2"] = e2
                if b2 and e2:
                    out["time2"] = out.get("time2") or f"{b2}–{e2}"

                # Keep stable identifiers
                out["section_id"] = str(out.get("id") or out.get("section_id") or "").strip()
                return out

            def _proposal_row_key(pr: dict) -> str:
                return str(pr.get("id") or pr.get("section_id") or "").strip()

            async def _update_proposal_for(fid_target: str, remove: bool = False):
                if not fid_target:
                    return
                prop = await db[COL_LOAD_PROPOSALS].find_one(
                    {"faculty_id": fid_target, "term_id": term_id},
                    {"_id": 0, "rows": 1, "status": 1},
                ) or {}
                rows0 = list(prop.get("rows") or []) if isinstance(prop.get("rows"), list) else []
                sid_key = str(r.get("id") or r.get("section_id") or "").strip()

                if remove:
                    rows1 = [pr for pr in rows0 if _proposal_row_key(pr) != sid_key]
                    await db[COL_LOAD_PROPOSALS].update_one(
                        {"faculty_id": fid_target, "term_id": term_id},
                        {"$set": {"rows": rows1, "status": "proposed", "locked": False, "updated_at": now}},
                        upsert=True,
                    )
                    return

                # Replace or append row
                new_row = _norm_for_faculty(r)
                replaced = False
                rows1 = []
                for pr in rows0:
                    if _proposal_row_key(pr) == sid_key:
                        rows1.append(new_row)
                        replaced = True
                    else:
                        rows1.append(pr)
                if not replaced:
                    rows1.append(new_row)

                await db[COL_LOAD_PROPOSALS].update_one(
                    {"faculty_id": fid_target, "term_id": term_id},
                    {"$set": {"rows": rows1, "status": "proposed", "locked": False, "updated_at": now},
                     "$setOnInsert": {"created_at": now}},
                    upsert=True,
                )

            try:
                # If reassigned, remove from previous faculty proposal doc
                if existing_fid and existing_fid != fid_raw:
                    await _update_proposal_for(existing_fid, remove=True)
                await _update_proposal_for(fid_raw, remove=False)
            except Exception:
                pass


        incoming_status = str(r.get("status") or "").strip()
        existing_status = str(existing.get("status") or "").strip()
        terminal = {"Approved", "Confirmed"}

        should_update_assignment = not (existing_status in terminal and not fid_raw and not incoming_status)
        if should_update_assignment:
            if incoming_status:
                next_status = incoming_status
            elif existing_status:
                next_status = existing_status
            else:
                next_status = "Pending"

            set_fields: dict[str, Any] = {
                "section_id": sid,
                "faculty_id": fid_raw,  # may be ""
                "status": next_status,
                "is_archived": False,
                "updated_at": _utcnow(),
            }
            if existing.get("assignment_id"):
                set_fields["assignment_id"] = existing["assignment_id"]
            if existing.get("load_id"):
                set_fields["load_id"] = existing["load_id"]

            await db[COL_ASSIGN].update_one(
                {"section_id": sid},
                {"$set": set_fields, "$setOnInsert": {"created_at": _utcnow()}},
                upsert=True,
            )

        # ---------- 2) section_schedules upsert / create (persist partial/blank inputs) ----------
        if not cid:
            # should not happen now, but guard anyway
            continue

        pairs = [("day1", "begin1", "end1", 1), ("day2", "begin2", "end2", 2)]
        for dkey, bkey, ekey, ordn in pairs:
            day = (r.get(dkey) or "").strip().upper()
            begin_hhmm = _norm_hhmm(r.get(bkey)) or ""
            end_hhmm = _norm_hhmm(r.get(ekey)) or ""

            # duplicate-slot check only when we have a complete slot
            if fid_raw and day and begin_hhmm and end_hhmm and _dup(fid_raw, day, begin_hhmm, end_hhmm):
                continue

            schedule_id = _sched_id(sid, ordn)

            def _compact_or_empty(hhmm: str) -> str:
                return _to_compact_hhmm(hhmm) if hhmm else ""

            # Try updating an existing schedule doc first (preserves room fields).
            result = await db[COL_SCHED].update_one(
                {"schedule_id": schedule_id},
                {
                    "$set": {
                        "term_id": term_id,
                        "section_id": sid,
                        "day": day,
                        "start_time": _compact_or_empty(begin_hhmm),
                        "end_time": _compact_or_empty(end_hhmm),
                        "updated_at": r.get("updated_at") or _utcnow(),
                    }
                },
                upsert=False,
            )

            if result.matched_count == 0:
                # No existing schedule doc; create one with safe defaults.
                now = _utcnow()
                await db[COL_SCHED].update_one(
                    {"schedule_id": schedule_id},
                    {
                        "$setOnInsert": {
                            "schedule_id": schedule_id,
                            "section_id": sid,
                            "room_id": "",
                            "room_type": "Lecture",
                            "created_at": now,
                        },
                        "$set": {
                            "term_id": term_id,
                            "day": day,
                            "start_time": _compact_or_empty(begin_hhmm),
                            "end_time": _compact_or_empty(end_hhmm),
                            "updated_at": r.get("updated_at") or now,
                        },
                    },
                    upsert=True,
                )

            if fid_raw and day and begin_hhmm and end_hhmm:
                _add_used(fid_raw, day, begin_hhmm, end_hhmm)

async def _upsert_faculty_load_header(
    term: dict,
    db,
    *,
    department_id: str,
    user_id: str,
    forwarded_section_ids: list[str] | None = None,
) -> None:
    """
    Ensure a faculty_loads header exists for this term+department
    with status='approved' and total_units computed from the term's sections.
    If it already exists, update status/total_units/timestamps.
    """
    if not term:
        return

    term_id = term.get("term_id")
    if not term_id:
        return

    # Use phase0 context to compute total units for all sections in this term.
    ctx = await phase0_load(term_id, db, department_id=None)
    total_units = 0
    for s in ctx.sections or []:
        # section.units, else course.units
        cid = s.get("course_id")
        units = s.get("units") or (ctx.courses.get(cid, {}) or {}).get("units")
        try:
            total_units += int(units or 0)
        except Exception:
            continue

    now = _utcnow()

    # Check if we already have a header for this term+department
    existing = await db[COL_FACULTY_LOADS].find_one(
        {"term_id": term_id, "department_id": department_id}
    )

    if not existing:
        # create new
        new_load_id = await _next_load_id(db)
        doc = {
            "load_id": new_load_id,
            "term_id": term_id,
            "department_id": department_id,
            "status": "approved",
            "total_units": total_units,
            "created_by": user_id,
            "created_at": now,
            "finalized_at": now,
            "updated_at": now,

            # NEW: marks that OM has forwarded/submitted to Chair
            "forwarded_to_chair": True,
            "forwarded_to_chair_at": now,
            # Snapshot of sections forwarded from OM Load Assignment table
            "forwarded_section_ids": sorted(list(set(forwarded_section_ids or []))),
            "forwarded_row_count": len(set(forwarded_section_ids or [])),
        }
        await db[COL_FACULTY_LOADS].insert_one(doc)
    else:
        # update existing header
        await db[COL_FACULTY_LOADS].update_one(
            {"_id": existing["_id"]},
            {
                "$set": {
                "status": "approved",
                "total_units": total_units,
                "updated_at": now,
                "finalized_at": now,
                # keep old created_by/created_at if already set
                "created_by": existing.get("created_by") or user_id,

                # NEW: ensure it's marked forwarded; preserve first forwarded timestamp if it exists
                "forwarded_to_chair": True,
                "forwarded_to_chair_at": now,
                # Always overwrite snapshot on re-forward so Chair sees exactly the current table rows
                "forwarded_section_ids": sorted(list(set(forwarded_section_ids or []))),
                "forwarded_row_count": len(set(forwarded_section_ids or [])),
            }
            },
        )

async def run_milestone_b(term_id: str, db, department_id: str | None = None) -> dict:
    """
    Outputs ordered worklist with per-course prioritized faculty pools,
    but DOES NOT perform the matching yet.
    """
    ctx = await phase0_load(term_id, db, department_id)
    phase1_kac_helpers(ctx)                  # Phase 1: course-level stats
    phase3_kac_prioritization(ctx)           # Phase 3: KAC-first ordering (sets ctx.course_order)

    caps = _faculty_capacities(ctx)

    # sections grouped by course
    by_course: dict[str, dict] = {}
    for s in ctx.sections:
        cid = s["course_id"]
        by_course.setdefault(cid, {"sections": [], "candidates": []})
        by_course[cid]["sections"].append(s["section_id"])

    # build prioritized candidate list per course (capacity, FT/PT, campus/mode)
    for cid in (ctx.course_order or []):
        # peek any section under the course to read campus/mode (good enough for B)
        any_sec = next((x for x in ctx.sections if x["course_id"] == cid), None) or {}
        campus = any_sec.get("campus_id") or any_sec.get("campus") or ""
        mode   = any_sec.get("mode") or "HYB"

        cands: list[dict] = []
        # ——— KAC set for this course comes from the KAC collection mapping we built in Phase 0
        course_kacs = set((getattr(ctx, "course_to_kacs", {}) or {}).get(cid, set()))

        # small counters for debug
        dbg_total = 0
        dbg_after_leave = 0
        dbg_kac_ok = 0
        dbg_campus_mode_ok = 0
        dbg_time_ok = 0

        for f in ctx.faculty:
            fid = f["faculty_id"]
            dbg_total += 1
            cap = int(caps.get(fid, 0))
            if cap <= 0:
                continue
             # GS rule: only PhD faculty can teach GS-program courses
            if _course_requires_phd(ctx, cid) and not _has_phd_cert(ctx, fid):
                continue        

            # (0) Require a submitted preference for the upcoming term
            # if fid not in ctx.prefs_by_faculty:
            #     continue
            has_prefs = fid in ctx.prefs_by_faculty

            # (0b) Exclude if on approved leave overlapping this term
            if fid in (getattr(ctx, "leave_blocked", set()) or set()):
                continue
            dbg_after_leave += 1   # NEW: survived leave gate

            # (A) LEAVE blackout (optional, from previous-term prefs payload)
            fpref = (ctx.prefs_by_faculty.get(fid) or {})
            ld = fpref.get("leave_data") or {}
            st = (ld or {}).get("start_term_id"); et = (ld or {}).get("end_term_id")
            # If both bounds exist and current term_id is inside, skip
            if st and et and (st <= ctx.term_id <= et):
                continue

            # (B) KAC gate: allow preferred KACs to count, then union with qualified
            pref_kacs = set((fpref.get("preferred_kacs") or fpref.get("preferred_kac") or []))
            qual_kacs = set(f.get("qualified_kacs") or f.get("kac_ids") or [])
            fac_kacs_union = pref_kacs | qual_kacs

            # If the course belongs to one or more KACs, require a non-empty intersection
            if course_kacs and not (fac_kacs_union and course_kacs.intersection(fac_kacs_union)):
                by_course.setdefault(cid, {})  # REMOVE after debugging FROM HERE
                by_course[cid].setdefault("_why", []).append({
                    "fid": fid,
                    "union_size": len(fac_kacs_union),
                    "course_kacs": sorted(list(course_kacs)),
                    "pref_kacs": sorted(list(pref_kacs)),
                    "qual_kacs": sorted(list(qual_kacs)),
                }) # REMOVE after debugging TO HERE
                continue
            dbg_kac_ok += 1

            # # (C) Campus / mode gates — drive strictly from THIS TERM’S preferences
            # fpref = (ctx.prefs_by_faculty.get(fid) or {})
            # if not _campus_compat_pref(fpref, campus):
            #     continue
            # if not _mode_compat_pref(fpref, mode):
            #     continue

            dbg_campus_mode_ok += 1
            dbg_time_ok += 1

            # (E) Course-aware scoring
            hx = int(getattr(ctx, "history_map", {}).get((fid, cid), 0))
            prefers_this_kac = 1 if (course_kacs and pref_kacs and course_kacs.intersection(pref_kacs)) else 0
            qual_matches_union = 1 if (course_kacs and course_kacs.intersection(fac_kacs_union)) else 0

            emp = (f.get("employment_type") or "").strip().upper()  # "FT" / "PT"
            ft_bonus = 1 if emp == "FT" else 0

            score = (40*prefers_this_kac) + (25*hx) + (10*ft_bonus) + (5*qual_matches_union) + min(cap, 12)
            if not has_prefs:
                score -= 20  # soft penalty, still eligible

            # --- NEW TAGS: solo-campus based on preferences of THIS TERM ---
            fpref = (ctx.prefs_by_faculty.get(fid) or {})
            campus_list = ((fpref.get("mode") or {}).get("campus_id") or [])
            campus_set = {str(x).strip().upper() for x in campus_list if x}
            is_solo_campus2 = (campus_set == {"CMPS0002"})
            is_ft_solo_campus2 = (emp == "FT" and is_solo_campus2)

            name = _display_name_from_users(ctx.users_by_faculty.get(fid))

            cands.append({
                "faculty_id": fid,
                "name": name,
                "remaining_units": cap,
                "employment_type": f.get("employment_type", ""),
                "score": score,
                # NEW: carry tags for downstream promotion
                "tags": {
                    "soloCampus2": bool(is_solo_campus2),
                    "FT_soloCampus2": bool(is_ft_solo_campus2),
                    # keep existing tags you already compute elsewhere (e.g., coordinator, soloKAC)
                },
            })

        # sort: higher score first, then more capacity, then FT, then name
        def _promote_flags(c):
            tags = c.get("tags", {}) or {}
            # True → 0, False → 1 so that promoted items come first
            is_coord = 0 if tags.get("coordinator") else 1
            is_ft_solo2 = 0 if tags.get("FT_soloCampus2") else 1
            is_solo2 = 0 if tags.get("soloCampus2") else 1
            is_solo_kac = 0 if tags.get("soloKAC") else 1
            return (is_coord, is_ft_solo2, is_solo2, is_solo_kac)

        cands.sort(key=lambda x: (
            *_promote_flags(x),
            -x["score"],
            -x["remaining_units"],
            0 if (x.get("employment_type","").strip().upper() == "FT") else 1,
            x["name"],
        ))

        by_course[cid]["candidates"] = cands

        # ------------------------------ PHASE 5 ------------------------------
        # Coordinator + Dynamic Top-K protection pools
        coord_ids: list[str] = _coordinator_for_course(ctx, cid)  # returns []
        topk_ids: list[str] = _compute_topk_for_course(by_course, cid, cands, max_topk=5)

        # If any coordinator is a valid candidate but not in Top-K, still protect them
        cand_ids = {c["faculty_id"] for c in cands}
        for fid in coord_ids:
            if fid in cand_ids and fid not in topk_ids:
                topk_ids.append(fid)

        # normalize Top-K (dedup while preserving order)
        topk_ids = list(dict.fromkeys(topk_ids))

        _apply_solo_kac_tags(ctx, by_course, cid, cands, course_kacs)
        _apply_protection_tags(by_course, cid, coord_ids, topk_ids)
        # --------------------------- END PHASE 5 -----------------------------

        by_course[cid]["_debug_filters"] = {
            "pool": dbg_total,
            "after_leave": dbg_after_leave,
            "after_kac": dbg_kac_ok,
            "after_campus_mode": dbg_campus_mode_ok,
            "after_time": dbg_time_ok,
            "final_candidates": len(cands),
        }

        # ---------- DEBUG: Phases 3–5 ----------
    # Phase 3 (KAC / course-type weighting) — show per-course score + sections
    dbg_phase3 = []
    stats = ctx.kac_helper.get("course_stats", {}) if ctx.kac_helper else {}
    for cid, st in stats.items():
        dbg_phase3.append({
            "course_id": cid,
            "type": st.get("type"),
            "sections": st.get("sections"),
            "units": st.get("units"),
            "score": st.get("score"),
        })
    # sort descending by score then sections (matches how we prioritize)
    dbg_phase3.sort(key=lambda x: (x["score"], x["sections"]), reverse=True)

    # Phase 4 (course prioritization) — the final ordered list we’ll process
    dbg_phase4 = ctx.course_order or []

    # Phase 5 (faculty prioritization per course) — top N with score breakdown
    TOP_N = 5
    dbg_phase5 = {}
    for cid in (ctx.course_order or []):
        candlist = by_course.get(cid, {}).get("candidates", [])
        # include score rationale if present
        dbg_phase5[cid] = [
            {
                "faculty_id": c.get("faculty_id"),
                "name": c.get("name"),
                "remaining_units": c.get("remaining_units"),
                "employment_type": c.get("employment_type"),
                "score": c.get("score"),
            }
            for c in candlist[:TOP_N]
        ]

        # KAC debug (Phase 3): ranked KACs and their aggregates
    dbg_kac_rank = []
    for kid in (getattr(ctx, "kac_order", []) or []):
        ks = getattr(ctx, "kac_stats", {}).get(kid, {})
        dbg_kac_rank.append({
            "kac_id": kid,
            "kac_name": ((getattr(ctx, "kacs", {}) or {}).get(kid) or {}).get("kac_name", ""),
            "score": ks.get("score", 0),
            "sections": ks.get("sections", 0),
            "units": ks.get("units", 0),
            "courses": list(dict.fromkeys(ks.get("courses", []))),  # unique preserve order
        })

    # collect per-course filter counts in course order for readability
    dbg_filters = {
        cid: by_course.get(cid, {}).get("_debug_filters", {})
        for cid in (ctx.course_order or [])
    }

    debug_payload = {
        "phase3_kac_course_stats": dbg_phase3,
        "phase3_kac_rank": dbg_kac_rank,
        "phase4_course_order": dbg_phase4,
        "phase5_top_candidates": dbg_phase5,
        "phase5_filter_counts": dbg_filters,
        "phase5_kac_why": {cid: by_course[cid].get("_why", []) for cid in (ctx.course_order or [])},
        # ------------------------------ PHASE 5 ------------------------------
        "phase5_protection_tags": {
            cid: (by_course.get(cid, {}).get("protection_tags", {}))
            for cid in (ctx.course_order or [])
        },
        # --------------------------- END PHASE 5 -----------------------------
        "pref_windows_quality": getattr(ctx, "pref_windows_quality", {}),
    }

    return {
        "term_id": term_id,
        "courses_order": ctx.course_order or [],
        "by_course": by_course,
        # keep assignments empty in Milestone B (no matching yet)
        "assignments": [],
        "debug": debug_payload, 
    }

# =============  END MILESTONE B  =============
def _aa_faculty_name(ctx: ContextA, faculty_id: str) -> str:
    return _display_name_from_users((ctx.users_by_faculty or {}).get(faculty_id) or {})


def _aa_pref_units(pref: dict | None) -> int:
    pref = pref or {}
    raw = pref.get("preferred_units") or pref.get("load_units") or 12
    try:
        return max(0, int(raw))
    except Exception:
        return 12


def _aa_collect_faculty_kacs(faculty_doc: dict, pref_doc: dict | None) -> set[str]:
    vals: set[str] = set()
    for src in (faculty_doc.get("qualified_kacs") or []), (faculty_doc.get("kac_ids") or []), ((pref_doc or {}).get("preferred_kacs") or []):
        for item in src:
            s = str(item or "").strip()
            if s:
                vals.add(s)
    return vals


def _aa_course_type(course_doc: dict) -> str:
    return str(course_doc.get("type_of_course") or course_doc.get("type") or "").strip().upper() or "OTHER"


def _aa_course_priority_value(course_doc: dict) -> int:
    ctype = _aa_course_type(course_doc)
    if ctype == "FOUNDATION":
        return 4
    if ctype == "MAJOR":
        return 3
    if ctype == "SHS":
        return 2
    if ctype == "GS":
        return 2
    return 1


def _aa_parse_pref_time_windows(pref: dict | None) -> list[tuple[int, int]]:
    pref = pref or {}
    raw = pref.get("preferred_times") or []
    seq = raw if isinstance(raw, list) else [raw]
    out: list[tuple[int, int]] = []
    for item in seq:
        st = en = None
        if isinstance(item, dict):
            st = _to_min(item.get("start") or item.get("begin"))
            en = _to_min(item.get("end") or item.get("finish"))
        elif isinstance(item, (list, tuple)) and len(item) == 2:
            st = _to_min(item[0]); en = _to_min(item[1])
        elif isinstance(item, str) and "-" in item:
            a, b = item.replace("–", "-").replace("—", "-").split("-", 1)
            st = _to_min(a); en = _to_min(b)
        if st is not None and en is not None and en > st:
            out.append((st, en))
    return out


def _aa_pref_days(pref: dict | None) -> list[str]:
    vals = []
    for d in ((pref or {}).get("availability_days") or []):
        s = str(d or "").strip().upper()
        if s:
            vals.append(s)
    return vals


def _aa_slot_to_pair(slot: dict) -> tuple[str | None, str | None, str | None]:
    d = (slot.get("day") or "").strip().upper() or None
    st = slot.get("begin") or slot.get("start")
    en = slot.get("end") or slot.get("finish")
    if isinstance(st, int):
        st = _mm_to_hhmm(st)
    if isinstance(en, int):
        en = _mm_to_hhmm(en)
    return d, st, en


async def _aa_history_bundle(term_id: str, db, faculty_ids: list[str], course_ids: list[str]) -> dict[str, Any]:
    """Build history using the real lineage:
    faculty_assignments.section_id -> sections.section_id -> {course_id, term_id}

    Notes:
    - Many faculty_assignments docs do not carry term_id, so term recency must come from sections.term_id.
    - Keep only historical sections from terms older than the current planning term.
    - Preserve schedule history from section_schedules using start_time/end_time.
    """
    terms = await db[COL_TERMS].find({}, {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1}).sort([("acad_year_start", 1), ("term_number", 1)]).to_list(None)
    term_rank = {str(t.get("term_id")): i for i, t in enumerate(terms or []) if t.get("term_id")}
    cur_rank = term_rank.get(term_id, 10**9)

    asg_query = {
        "faculty_id": {"$nin": [None, ""]},
        "section_id": {"$nin": [None, ""]},
    }
    if faculty_ids:
        asg_query["faculty_id"] = {"$in": faculty_ids}

    asg_rows = await db[COL_ASSIGN].find(
        asg_query,
        {"_id": 0, "faculty_id": 1, "section_id": 1, "created_at": 1},
    ).to_list(None)

    section_ids = sorted({str(r.get("section_id")) for r in (asg_rows or []) if r.get("section_id")})
    sec_docs = []
    sched_docs = []
    if section_ids:
        sec_docs = await db[COL_SECTIONS].find(
            {"section_id": {"$in": section_ids}},
            {"_id": 0, "section_id": 1, "course_id": 1, "term_id": 1, "campus_id": 1, "owner_batch_id": 1, "owner_program_id": 1},
        ).to_list(None)
        sched_docs = await db[COL_SCHED].find(
            {"section_id": {"$in": section_ids}},
            {"_id": 0, "section_id": 1, "day": 1, "start_time": 1, "begin_time": 1, "end_time": 1},
        ).to_list(None)

    sec_by_id = {str(s.get("section_id")): s for s in sec_docs if s.get("section_id")}
    sched_by_sid: dict[str, list[dict]] = {}
    for sch in (sched_docs or []):
        sid = str(sch.get("section_id") or "")
        if sid:
            sched_by_sid.setdefault(sid, []).append(sch)

    course_history: dict[str, list[dict]] = {}
    faculty_course_history: dict[str, dict[str, dict]] = {}
    schedule_history: dict[tuple[str, str], list[dict]] = {}

    for row in (asg_rows or []):
        fid = str(row.get("faculty_id") or "").strip()
        sid = str(row.get("section_id") or "").strip()
        if not fid or not sid:
            continue
        sec = sec_by_id.get(sid) or {}
        cid = str(sec.get("course_id") or "").strip()
        t_id = str(sec.get("term_id") or "").strip()
        if not cid or not t_id or (course_ids and cid not in course_ids):
            continue
        rank = term_rank.get(t_id)
        if rank is None or rank >= cur_rank:
            continue

        item = faculty_course_history.setdefault(
            fid,
            {}
        ).setdefault(
            cid,
            {
                "latest_rank": -1,
                "latest_term_id": "",
                "latest_term_label": "",
                "count": 0,
                "slots": [],
            },
        )
        item["count"] += 1
        if rank > item["latest_rank"]:
            item["latest_rank"] = rank
            item["latest_term_id"] = t_id
            term_doc = next((t for t in (terms or []) if str(t.get("term_id") or "").strip() == t_id), None)
            item["latest_term_label"] = _term_label(term_doc or {"term_id": t_id})
            item["slots"] = []
            for sch in sched_by_sid.get(sid, []):
                d = str(sch.get("day") or "").strip().upper()
                st = _to_min(sch.get("start_time") or sch.get("begin_time"))
                en = _to_min(sch.get("end_time"))
                if d and st is not None and en is not None and en > st:
                    item["slots"].append({"day": d, "begin": st, "end": en})
        course_history.setdefault(cid, [])

    for fid, cmap in faculty_course_history.items():
        for cid, info in cmap.items():
            course_history.setdefault(cid, []).append({
                "faculty_id": fid,
                "latest_rank": info.get("latest_rank", -1),
                "count": info.get("count", 0),
            })
            schedule_history[(fid, cid)] = list(info.get("slots") or [])

    for cid, items in course_history.items():
        items.sort(key=lambda x: (x.get("latest_rank", -1), x.get("count", 0)), reverse=True)

    return {
        "term_rank": term_rank,
        "course_history": course_history,
        "faculty_course_history": faculty_course_history,
        "schedule_history": schedule_history,
    }


def _aa_is_gs_qualified(course_doc: dict, faculty_doc: dict) -> bool:
    lvl = str(course_doc.get("program_level") or "").strip().upper()
    if lvl != "GS":
        return True
    certs = {str(x or "").strip().upper() for x in (faculty_doc.get("certifications") or [])}
    return "PHD" in certs


def _aa_schedule_conflict(used_slots: dict[str, list[tuple[str, int, int, str]]], faculty_id: str, day: str, start_min: int, end_min: int) -> bool:
    for d, st, en, _sid in used_slots.get(faculty_id, []):
        if d != day:
            continue
        if max(st, start_min) < min(en, end_min):
            return True
    return False


def _aa_respects_pref_window(pref: dict | None, day: str, start_min: int, end_min: int) -> bool:
    days = _aa_pref_days(pref)
    if days and day not in days:
        return False
    windows = _aa_parse_pref_time_windows(pref)
    if not windows:
        return True
    for st, en in windows:
        if start_min >= st and end_min <= en:
            return True
    return False


def _aa_candidate_course_order(section_pool: list[dict], ctx: ContextA, course_history: dict[str, list[dict]]) -> list[dict]:
    counts: dict[str, int] = {}
    for sec in section_pool:
        counts[sec["course_id"]] = counts.get(sec["course_id"], 0) + 1
    for sec in section_pool:
        cid = sec["course_id"]
        cdoc = (ctx.courses or {}).get(cid) or {}
        sec["_priority"] = (
            counts.get(cid, 0),
            _aa_course_priority_value(cdoc),
            -len(course_history.get(cid, []) or []),
        )
    return sorted(section_pool, key=lambda s: s.get("_priority") or (0,0,0), reverse=True)


def _aa_reason_confidence(reason: str) -> str:
    if reason in {"recent_history", "pt_history", "history_rescue"}:
        return "high"
    if reason in {"older_history", "kac_fallback", "pt_kac", "ft_extra_history"}:
        return "medium"
    return "low"




def _aa_remove_assigned_section_id(faculty_state: dict, section_id: str) -> None:
    kept = [sid for sid in (faculty_state.get("assigned_section_ids") or []) if str(sid) != str(section_id)]
    faculty_state["assigned_section_ids"] = kept


def _aa_course_key_for_section(section: dict) -> str:
    return str(section.get("course_id") or "").strip()


def _aa_prep_sets_from_assignments(assignments: list[dict], section_lookup: dict[str, dict]) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for item in (assignments or []):
        fid = str(item.get("faculty_id") or "").strip()
        sec = section_lookup.get(str(item.get("section_id") or "")) or {}
        course_key = _aa_course_key_for_section(sec)
        if not fid or not course_key:
            continue
        out.setdefault(fid, set()).add(course_key)
    return out


def _aa_pick_rebalance_target(
    source_fid: str,
    item: dict,
    faculty_states: list[dict],
    faculty_state_by_id: dict[str, dict],
    section_lookup: dict[str, dict],
    ctx: ContextA,
    prep_sets: dict[str, set[str]],
) -> dict | None:
    sec = section_lookup.get(str(item.get("section_id") or "")) or {}
    course_key = _aa_course_key_for_section(sec)
    if not course_key:
        return None
    ranked: list[tuple[tuple, dict]] = []
    for fstate in faculty_states:
        fid = str(fstate.get("faculty_id") or "").strip()
        if not fid or fid == source_fid:
            continue
        if not _aa_faculty_can_take_section(fstate, sec, ctx, require_pref_for_pt=(fstate.get("employment_type") == "PT")):
            continue
        current_preps = set(prep_sets.get(fid) or set())
        already_has_prep = course_key in current_preps
        next_prep_count = len(current_preps) if already_has_prep else len(current_preps) + 1
        if next_prep_count > 3:
            continue
        desired_units = int(fstate.get("desired_teaching_units") or 0)
        assigned_units = int(fstate.get("assigned_teaching_units") or 0)
        sec_units = int(sec.get("units") or 0)
        overload_after = max(0, assigned_units + sec_units - desired_units)
        key = (
            0 if already_has_prep else 1,
            next_prep_count,
            overload_after,
            assigned_units,
            str(fstate.get("employment_type") or "") != "FT",
            fid,
        )
        ranked.append((key, fstate))
    ranked.sort(key=lambda x: x[0])
    return ranked[0][1] if ranked else None


def _aa_rebalance_max_preps(
    assignments: list[dict],
    section_lookup: dict[str, dict],
    faculty_states: list[dict],
    faculty_state_by_id: dict[str, dict],
    ctx: ContextA,
    trace: list[dict],
) -> dict[str, Any]:
    prep_limit = 3
    moves: list[dict] = []
    if not assignments:
        return {"max_preps_rebalance": {"moves": moves, "over_limit_after": {}}}

    while True:
        prep_sets = _aa_prep_sets_from_assignments(assignments, section_lookup)
        over_limit = sorted(
            [
                (fid, len(courses))
                for fid, courses in prep_sets.items()
                if len(courses) > prep_limit
            ],
            key=lambda x: (x[1], x[0]),
            reverse=True,
        )
        if not over_limit:
            break
        moved_any = False
        for source_fid, _prep_count in over_limit:
            source_state = faculty_state_by_id.get(source_fid)
            if not source_state:
                continue
            source_items = [a for a in assignments if str(a.get("faculty_id") or "") == source_fid]
            by_course: dict[str, list[dict]] = {}
            for item in source_items:
                sec = section_lookup.get(str(item.get("section_id") or "")) or {}
                course_key = _aa_course_key_for_section(sec)
                if course_key:
                    by_course.setdefault(course_key, []).append(item)
            if len(by_course) <= prep_limit:
                continue
            ranked_courses = sorted(by_course.items(), key=lambda kv: (len(kv[1]), kv[0]))
            keep_courses = {course for course, _items in sorted(by_course.items(), key=lambda kv: (-len(kv[1]), kv[0]))[:prep_limit]}
            candidate_items: list[dict] = []
            for course_key, items in ranked_courses:
                if course_key in keep_courses:
                    continue
                candidate_items.extend(sorted(items, key=lambda a: str(a.get("section_id") or "")))
            for item in candidate_items:
                sec = section_lookup.get(str(item.get("section_id") or "")) or {}
                course_key = _aa_course_key_for_section(sec)
                target_state = _aa_pick_rebalance_target(source_fid, item, faculty_states, faculty_state_by_id, section_lookup, ctx, prep_sets)
                if not target_state:
                    continue
                target_fid = str(target_state.get("faculty_id") or "")
                units = int(sec.get("units") or 0)
                source_state["assigned_teaching_units"] = max(0, int(source_state.get("assigned_teaching_units") or 0) - units)
                source_state["total_credited_units"] = max(int(source_state.get("deload_units") or 0), int(source_state.get("total_credited_units") or 0) - units)
                _aa_remove_assigned_section_id(source_state, str(item.get("section_id") or ""))
                target_state["assigned_teaching_units"] = int(target_state.get("assigned_teaching_units") or 0) + units
                target_state["total_credited_units"] = int(target_state.get("total_credited_units") or 0) + units
                target_state.setdefault("assigned_section_ids", []).append(str(item.get("section_id") or ""))
                old_faculty = item.get("faculty")
                item["faculty_id"] = target_fid
                item["faculty"] = target_state.get("name")
                item["reason"] = "max_preps_rebalance"
                item["round"] = "postpass_max_preps"
                for tr in reversed(trace):
                    if tr.get("section_id") == item.get("section_id") and tr.get("faculty_id") == source_fid:
                        tr["rebalanced"] = True
                        tr["rebalance_reason"] = "MAX_PREPS"
                        tr["rebalance_target_faculty_id"] = target_fid
                        tr["rebalance_target_faculty"] = target_state.get("name")
                        break
                trace.append({
                    "section_id": item.get("section_id"),
                    "course_id": item.get("course_id"),
                    "faculty_id": target_fid,
                    "faculty": target_state.get("name"),
                    "round": "postpass_max_preps",
                    "reason_type": "max_preps_rebalance",
                    "reason_label": "MAX_PREPS rebalance",
                    "reason_sentence": f"Reassigned from {old_faculty or source_fid} to reduce prep overload.",
                    "history_term_label": "",
                    "confidence": "medium",
                    "below_12_before": False,
                    "teaching_units_before": int(target_state.get("assigned_teaching_units") or 0) - units,
                    "teaching_units_after": int(target_state.get("assigned_teaching_units") or 0),
                    "total_units_before": int(target_state.get("total_credited_units") or 0) - units,
                    "total_units_after": int(target_state.get("total_credited_units") or 0),
                    "rebalanced_from_faculty_id": source_fid,
                    "rebalanced_from_faculty": old_faculty,
                })
                moves.append({
                    "section_id": item.get("section_id"),
                    "course_id": item.get("course_id"),
                    "from_faculty_id": source_fid,
                    "to_faculty_id": target_fid,
                    "course_key": course_key,
                })
                moved_any = True
                break
            if moved_any:
                break
        if not moved_any:
            break

    final_prep_sets = _aa_prep_sets_from_assignments(assignments, section_lookup)
    over_limit_after = {
        fid: sorted(list(courses))
        for fid, courses in final_prep_sets.items()
        if len(courses) > prep_limit
    }
    return {
        "max_preps_rebalance": {
            "moves": moves,
            "over_limit_after": over_limit_after,
        }
    }

def _aa_assign_section(
    faculty_state: dict,
    section: dict,
    reason: str,
    round_name: str,
    trace: list[dict],
    assignments: list[dict]
):
    before_teaching = faculty_state["assigned_teaching_units"]
    before_total = faculty_state["total_credited_units"]
    units = int(section.get("units") or 0)

    faculty_state["assigned_teaching_units"] += units
    faculty_state["total_credited_units"] += units
    faculty_state["assigned_section_ids"].append(section["section_id"])

    assignments.append({
        "section_id": section["section_id"],
        "course_id": section["course_id"],
        "faculty_id": faculty_state["faculty_id"],
        "faculty": faculty_state["name"],
        "day1": None, "begin1": None, "end1": None,
        "day2": None, "begin2": None, "end2": None,
        "reason": reason,
        "round": round_name,
    })

    # INSERT HERE
    if reason in {"kac_fallback", "ft_extra_kac", "pt_kac"}:
        course_id = str(section.get("course_id") or "").strip()
        faculty_id = str(faculty_state.get("faculty_id") or "").strip()
        section_id = str(section.get("section_id") or "").strip()
        course_code = str(section.get("course_code") or section.get("course") or "").strip()

        fkacs = sorted(list(set(faculty_state.get("kacs") or [])))

        _aa_kac_log(
            f"[AA KAC ASSIGN] "
            f"reason={reason} "
            f"faculty_id={faculty_id} "
            f"faculty={faculty_state.get('name')} "
            f"section_id={section_id} "
            f"course_id={course_id} "
            f"course={course_code} "
            f"faculty_kacs={fkacs} "
        )

    history_info = ((faculty_state.get("history") or {}).get(section["course_id"]) or {})
    history_term_label = str(history_info.get("latest_term_label") or "").strip()

    trace.append({
        "section_id": section["section_id"],
        "course_id": section["course_id"],
        "faculty_id": faculty_state["faculty_id"],
        "faculty": faculty_state["name"],
        "round": round_name,
        "reason_type": reason,
        "reason_label": _aa_reason_label(reason),
        "reason_sentence": _aa_reason_sentence(reason, history_term_label),
        "history_term_label": history_term_label,
        "confidence": _aa_reason_confidence(reason),
        "below_12_before": before_total < 12,
        "teaching_units_before": before_teaching,
        "teaching_units_after": faculty_state["assigned_teaching_units"],
        "total_units_before": before_total,
        "total_units_after": faculty_state["total_credited_units"],
    })


def _aa_pick_history_section(faculty_state: dict, remaining_sections: list[dict], course_history: dict[str, list[dict]], *, latest_only: bool) -> dict | None:
    fid = faculty_state["faculty_id"]
    best = None
    best_key = None
    for sec in remaining_sections:
        hist = course_history.get(sec["course_id"], [])
        rank = None
        for idx, item in enumerate(hist):
            if item.get("faculty_id") == fid:
                rank = idx
                if latest_only and idx != 0:
                    rank = None
                break
        if rank is None:
            continue
        key = (-(sec.get("_priority") or (0,0,0))[0], rank, -int(sec.get("units") or 0), sec.get("section_id"))
        if best is None or key < best_key:
            best = sec
            best_key = key
    return best


def _aa_history_candidates_for_faculty(faculty_state: dict, remaining_sections: list[dict], course_history: dict[str, list[dict]], *, latest_only: bool) -> list[dict]:
    fid = faculty_state["faculty_id"]
    ranked: list[tuple[tuple, dict]] = []
    for sec in remaining_sections:
        hist = course_history.get(sec["course_id"], [])
        rank = None
        for idx, item in enumerate(hist):
            if item.get("faculty_id") == fid:
                if latest_only and idx != 0:
                    rank = None
                else:
                    rank = idx
                break
        if rank is None:
            continue
        key = (-(sec.get("_priority") or (0,0,0))[0], rank, -int(sec.get("units") or 0), sec.get("section_id"))
        ranked.append((key, sec))
    ranked.sort(key=lambda x: x[0])
    return [sec for _key, sec in ranked]


def _aa_faculty_can_take_section(faculty_state: dict, section: dict, ctx: ContextA, *, require_pref_for_pt: bool = False) -> bool:
    faculty_doc = faculty_state["faculty_doc"]
    pref = faculty_state["pref"]
    fid = str(faculty_state.get("faculty_id") or "")
    sec_id = str(section.get("section_id") or "")
    if not fid:
        # print(f"[AA REJECT] sec={sec_id} fac={fid or '<blank>'} reason=blank_faculty_id")
        return False
    if fid in (getattr(ctx, "leave_blocked", set()) or set()):
        # print(f"[AA REJECT] sec={sec_id} fac={fid} reason=leave_blocked")
        return False
    if require_pref_for_pt and not pref:
        # print(f"[AA REJECT] sec={sec_id} fac={fid} reason=pt_no_preference_doc")
        return False
    if faculty_state.get("employment_type") == "PT" and require_pref_for_pt and not _aa_pref_days(pref) and not _aa_parse_pref_time_windows(pref):
        # print(f"[AA REJECT] sec={sec_id} fac={fid} reason=pt_no_pref_days_or_times")
        return False
    if not _aa_is_gs_qualified((ctx.courses or {}).get(section["course_id"], {}) or {}, faculty_doc):
        # print(f"[AA REJECT] sec={sec_id} fac={fid} reason=gs_rule course_id={section.get('course_id')}")
        return False
    sec_mode = str(section.get("mode") or "").strip().upper()
    pref_mode = str(((pref or {}).get("mode") or {}).get("mode") or "").strip().upper()
    if sec_mode and pref_mode and sec_mode != pref_mode:
        # print(f"[AA REJECT] sec={sec_id} fac={fid} reason=mode_mismatch section_mode={sec_mode} pref_mode={pref_mode}")
        return False
    sec_campus = str(section.get("campus_id") or "").strip().upper()
    pref_campus = str((pref or {}).get("campus_id") or "").strip().upper()
    if sec_campus and pref_campus and sec_campus != pref_campus:
        # print(f"[AA REJECT] sec={sec_id} fac={fid} reason=campus_mismatch section_campus={sec_campus} pref_campus={pref_campus}")
        return False
    return True


def _aa_pick_kac_section(faculty_state: dict, remaining_sections: list[dict], ctx: ContextA) -> dict | None:
    fkacs = faculty_state["kacs"]
    fid = str(faculty_state.get("faculty_id") or "")
    # print(f"[ROUND2 KAC] fac={fid} faculty_kacs={sorted(list(fkacs)) if fkacs else []}")
    best = None
    best_key = None
    for sec in remaining_sections:
        if not _aa_faculty_can_take_section(faculty_state, sec, ctx):
            continue
        ckacs = set(((getattr(ctx, "course_to_kacs", {}) or {}).get(sec["course_id"]) or set()))
        # print(f"[ROUND2 KAC] fac={fid} sec={sec.get('section_id')} course={sec.get('course_id')} course_kacs={sorted(list(ckacs)) if ckacs else []}")
        if fkacs and ckacs and not (fkacs & ckacs):
            _aa_kac_log(
                f"[AA KAC REJECT] "
                f"faculty_id={fid} "
                f"faculty={faculty_state.get('name')} "
                f"section_id={sec.get('section_id')} "
                f"course_id={sec.get('course_id')} "
                f"faculty_kacs={sorted(list(fkacs))} "
                f"course_kacs={sorted(list(ckacs))} "
                f"overlap=[]"
            )
            continue
        scarcity = len(ckacs) if ckacs else 99
        key = (-(sec.get("_priority") or (0,0,0))[0], scarcity, sec.get("section_id"))
        if best is None or key < best_key:
            best = sec
            best_key = key
    return best

def _aa_pick_pt_section(faculty_state: dict, remaining_sections: list[dict], course_history: dict[str, list[dict]], ctx: ContextA) -> tuple[dict | None, str | None]:
    sec = _aa_pick_history_section(faculty_state, remaining_sections, course_history, latest_only=False)
    if sec and _aa_faculty_can_take_section(faculty_state, sec, ctx, require_pref_for_pt=True):
        return sec, "pt_history"
    sec = _aa_pick_kac_section(faculty_state, remaining_sections, ctx)
    if sec and _aa_faculty_can_take_section(faculty_state, sec, ctx, require_pref_for_pt=True):
        return sec, "pt_kac"
    return None, None


def _aa_normalize_pref_days(pref: dict | None) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for d in _aa_pref_days(pref):
        s = str(d or "").strip().upper()
        if s == "TH":
            s = "H"
        if s in {"M", "T", "W", "H", "F", "S"} and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _aa_mode_for_assignment(section: dict, faculty_state: dict) -> str:
    pref = faculty_state.get("pref") or {}
    pref_mode = str(((pref.get("mode") or {}).get("mode") or pref.get("mode") or "")).strip().upper()
    if pref_mode:
        return pref_mode
    return str(section.get("mode") or "").strip().upper()


def _aa_slot_candidates(section: dict, faculty_state: dict, ctx: ContextA, schedule_history: dict[tuple[str, str], list[dict]]) -> list[dict]:
    sid = section["section_id"]
    cid = section["course_id"]
    fid = faculty_state["faculty_id"]
    pref = faculty_state.get("pref") or {}
    candidates: list[dict] = []
    seen: set[tuple[str, str | None, str, str]] = set()

    def add(day1: str, begin: str, end: str, basis: str, day2: str | None = None):
        d1 = str(day1 or "").strip().upper()
        d2 = str(day2 or "").strip().upper() or None
        b = str(begin or "").strip()
        e = str(end or "").strip()
        if not (d1 and b and e):
            return
        key = (d1, d2, b, e)
        if key in seen:
            return
        seen.add(key)
        candidates.append({"day1": d1, "day2": d2, "begin": b, "end": e, "basis": basis})

    pref_days = _aa_normalize_pref_days(pref)
    pref_windows = _aa_parse_pref_time_windows(pref)
    pair_buckets = (("M", "H"), ("T", "F"), ("W", "S"))

    if pref_days and pref_windows:
        day_set = set(pref_days)
        for st, en in pref_windows:
            begin = _mm_to_hhmm(st)
            end = _mm_to_hhmm(en)
            for anchor, mate in pair_buckets:
                has_anchor = anchor in day_set
                has_mate = mate in day_set
                if has_anchor and has_mate:
                    add(anchor, begin, end, "preference_based_slot", mate)
                elif has_anchor:
                    add(anchor, begin, end, "preference_based_slot")
                elif has_mate:
                    add(mate, begin, end, "preference_based_slot")
        return candidates

    for sch in (schedule_history.get((fid, cid)) or []):
        d, b, e = _aa_slot_to_pair(sch)
        if d and b and e:
            add(d, b, e, "reused_course_history")

    for sch in (ctx.schedules_by_section or {}).get(sid, []):
        d = (sch.get("day") or "").strip().upper()
        b = sch.get("begin_time") or sch.get("start_time")
        e = sch.get("end_time")
        if d and b and e:
            add(d, b, e, "existing_section_schedule")

    days = pref_days or ["M", "T", "W", "H", "F", "S"]
    if pref_windows:
        for st, en in pref_windows:
            for d in days:
                add(d, _mm_to_hhmm(st), _mm_to_hhmm(en), "preference_based_slot")

    if not candidates:
        for d in days:
            for begin, end in [("07:30", "09:00"), ("09:15", "10:45"), ("11:00", "12:30"), ("12:45", "14:15"), ("14:30", "16:00"), ("16:15", "17:45")]:
                add(d, begin, end, "balance_based_slot")
    return candidates


def _aa_schedule_score(candidate: dict, faculty_state: dict, section: dict, used_slots: dict[str, list[tuple[str, int, int, str]]], course_day_usage: dict[str, dict[str, int]]) -> int:
    day1 = candidate["day1"]
    day2 = candidate.get("day2")
    begin = candidate["begin"]
    end = candidate["end"]
    basis = candidate.get("basis") or ""
    st = _to_min(begin); en = _to_min(end)
    if st is None or en is None or en <= st:
        return -10**6
    score = 0
    if basis == "reused_course_history":
        score += 90
    elif basis == "existing_section_schedule":
        score += 60
    elif basis == "preference_based_slot":
        score += 45
    if _aa_respects_pref_window(faculty_state.get("pref"), day1, st, en):
        score += 25
    if day2 and _aa_respects_pref_window(faculty_state.get("pref"), day2, st, en):
        score += 10
    score -= 20 * course_day_usage.get(section["course_id"], {}).get(day1, 0)
    if day2:
        score -= 20 * course_day_usage.get(section["course_id"], {}).get(day2, 0)
    score -= 5 * len(used_slots.get(faculty_state["faculty_id"], []))
    return score


def _aa_assign_schedule(assignments: list[dict], section_lookup: dict[str, dict], faculty_state_by_id: dict[str, dict], ctx: ContextA, schedule_history: dict[tuple[str, str], list[dict]], trace: list[dict]) -> dict[str, Any]:
    used_slots: dict[str, list[tuple[str, int, int, str]]] = {}
    course_day_usage: dict[str, dict[str, int]] = {}
    no_time: dict[str, dict] = {}

    def _streak_violation(used: dict[str, list[tuple[str, int, int, str]]], faculty_id: str, day: str | None, start_min: int | None, end_min: int | None) -> bool:
        if not (faculty_id and day and start_min is not None and end_min is not None and end_min > start_min):
            return False
        existing = [(st, en) for d, st, en, _sid in used.get(faculty_id, []) if d == day]
        return not _streak_ok_for_day(existing, [(start_min, end_min)])

    protected_ids = set(getattr(ctx, "protected_section_ids", set()) or set())
    current_assignment_by_section = getattr(ctx, "current_assignment_by_section", {}) or {}

    # seed with protected/current table schedules already present in DB context
    for sid, scheds in (ctx.schedules_by_section or {}).items():
        if protected_ids and sid not in protected_ids:
            continue
        fid = str(current_assignment_by_section.get(sid) or "")
        if not fid:
            continue
        for sch in (scheds or []):
            day = str(sch.get("day") or "").strip().upper()
            st = _to_min(sch.get("begin_time") or sch.get("start_time") or sch.get("begin"))
            en = _to_min(sch.get("end_time") or sch.get("end") or sch.get("finish"))
            if not day or st is None or en is None or en <= st:
                continue
            used_slots.setdefault(fid, []).append((day, st, en, sid))
            sec = section_lookup.get(sid) or {}
            cid = str(sec.get("course_id") or "")
            if cid:
                course_day_usage.setdefault(cid, {}).setdefault(day, 0)
                course_day_usage[cid][day] += 1

    for item in assignments:
        sec = section_lookup.get(item["section_id"]) or {}
        fid = item["faculty_id"]
        fstate = faculty_state_by_id.get(fid) or {}
        chosen = None
        best_score = None
        for cand in _aa_slot_candidates(sec, fstate, ctx, schedule_history):
            day1 = cand["day1"]
            day2 = cand.get("day2")
            st = _to_min(cand["begin"])
            en = _to_min(cand["end"])
            if st is None or en is None or en <= st:
                continue
            if _aa_schedule_conflict(used_slots, fid, day1, st, en):
                continue
            if day2 and _aa_schedule_conflict(used_slots, fid, day2, st, en):
                continue
            if not _aa_respects_pref_window(fstate.get("pref"), day1, st, en):
                continue
            if day2 and not _aa_respects_pref_window(fstate.get("pref"), day2, st, en):
                continue
            if _streak_violation(used_slots, fid, day1, st, en):
                continue
            if day2 and _streak_violation(used_slots, fid, day2, st, en):
                continue
            score = _aa_schedule_score(cand, fstate, sec, used_slots, course_day_usage)
            if chosen is None or score > best_score:
                chosen = cand
                best_score = score
        if not chosen:
            no_time[item["section_id"]] = {
                "reason": "no_free_slot_from_pool",
                "faculty_id": fid,
                "course_id": item.get("course_id"),
            }
            continue
        day1 = chosen["day1"]
        day2 = chosen.get("day2")
        begin = chosen["begin"]
        end = chosen["end"]
        item["day1"], item["begin1"], item["end1"] = day1, begin, end
        item["day2"], item["begin2"], item["end2"] = None, None, None
        item["mode"] = _aa_mode_for_assignment(sec, fstate)
        used_slots.setdefault(fid, []).append((day1, _to_min(begin), _to_min(end), item["section_id"]))
        course_day_usage.setdefault(item["course_id"], {}).setdefault(day1, 0)
        course_day_usage[item["course_id"]][day1] += 1
        if day2:
            item["day2"], item["begin2"], item["end2"] = day2, begin, end
            used_slots.setdefault(fid, []).append((day2, _to_min(begin), _to_min(end), item["section_id"]))
            course_day_usage.setdefault(item["course_id"], {}).setdefault(day2, 0)
            course_day_usage[item["course_id"]][day2] += 1
        for tr in reversed(trace):
            if tr.get("section_id") == item["section_id"] and tr.get("faculty_id") == fid:
                tr["schedule_basis"] = chosen.get("basis")
                tr["schedule_quality_score"] = best_score
                break
    return {"phase7_no_time_details": no_time}


async def _compute_load_recommendations_v2(
    term_id: str,
    db,
    *,
    department_id: str | None = None,
    protected_section_ids: set[str] | None = None,
    source_rows: list[dict] | None = None,
) -> dict:
    protected_section_ids = set(protected_section_ids or set())
    ctx = await phase0_load(term_id, db, department_id)

    faculty_ids = [str(f.get("faculty_id")) for f in (ctx.faculty or []) if f.get("faculty_id")]
    row_universe = [dict(r) for r in (source_rows or [])]
    if row_universe:
        course_ids = sorted({str(r.get("course_id") or "") for r in row_universe if r.get("course_id")})
    else:
        course_ids = sorted({str(s.get("course_id")) for s in (ctx.sections or []) if s.get("course_id")})
    history_bundle = await _aa_history_bundle(term_id, db, faculty_ids, course_ids)
    course_history = history_bundle["course_history"]
    faculty_course_history = history_bundle["faculty_course_history"]
    schedule_history = history_bundle["schedule_history"]

    deload_rows = await db["deloadings"].find({"term_id": term_id}, {"_id": 0, "faculty_id": 1, "units_deloaded": 1}).to_list(None)
    deload_by_faculty: dict[str, int] = {}
    for row in (deload_rows or []):
        fid = str(row.get("faculty_id") or "")
        if fid:
            try:
                deload_by_faculty[fid] = deload_by_faculty.get(fid, 0) + int(row.get("units_deloaded") or 0)
            except Exception:
                pass

    faculty_states: list[dict] = []
    faculty_state_by_id: dict[str, dict] = {}
    for fdoc in (ctx.faculty or []):
        fid = str(fdoc.get("faculty_id") or "")
        if not fid:
            continue
        pref = (ctx.prefs_by_faculty or {}).get(fid) or {}
        current_teaching = int((getattr(ctx, "current_assigned_units", {}) or {}).get(fid, 0) or 0)
        deload_units = int(deload_by_faculty.get(fid, 0) or 0)
        desired_teaching_units = _aa_pref_units(pref)
        state = {
            "faculty_id": fid,
            "name": _aa_faculty_name(ctx, fid),
            "employment_type": str(fdoc.get("employment_type") or "").strip().upper(),
            "faculty_doc": fdoc,
            "pref": pref,
            "kacs": _aa_collect_faculty_kacs(fdoc, pref),
            "current_teaching_units": current_teaching,
            "assigned_teaching_units": current_teaching,
            "deload_units": deload_units,
            "total_credited_units": current_teaching + deload_units,
            "desired_teaching_units": desired_teaching_units,
            "assigned_section_ids": [],
            "history": faculty_course_history.get(fid, {}),
        }
        faculty_states.append(state)
        faculty_state_by_id[fid] = state

    section_lookup: dict[str, dict] = {}
    section_pool: list[dict] = []

    if row_universe:
        for row in row_universe:
            sid = str(row.get("id") or row.get("section_id") or "")
            cid = str(row.get("course_id") or "")
            if not sid or not cid:
                continue
            course_doc = (ctx.courses or {}).get(cid) or {}
            try:
                units = int(row.get("units") or course_doc.get("units") or 3)
            except Exception:
                units = int(course_doc.get("units") or 3)
            batch_val = row.get("batch_id") or row.get("owner_batch_id") or row.get("batch_number") or None
            section = {
                "section_id": sid,
                "course_id": cid,
                "units": units,
                "campus_id": str(row.get("campus_id") or ""),
                "mode": row.get("mode") or course_doc.get("mode") or "",
                "batch_id": batch_val,
                "program_id": row.get("program_id") or row.get("owner_program_id") or None,
                "status": row.get("status") or "",
                "faculty_id": row.get("faculty_id") or "",
            }
            section_lookup[sid] = section
            if sid in protected_section_ids:
                continue
            section_pool.append(section)
    else:
        for sec in (ctx.sections or []):
            sid = str(sec.get("section_id") or "")
            cid = str(sec.get("course_id") or "")
            if not sid or not cid or sid in protected_section_ids:
                continue
            course_doc = (ctx.courses or {}).get(cid) or {}
            units = int(sec.get("units") or course_doc.get("units") or 3)
            section = {
                "section_id": sid,
                "course_id": cid,
                "units": units,
                "campus_id": str(sec.get("campus_id") or ""),
                "mode": sec.get("mode") or course_doc.get("mode") or "",
                "batch_id": sec.get("owner_batch_id") or sec.get("batch_number") or None,
                "program_id": sec.get("owner_program_id") or None,
            }
            section_lookup[sid] = section
            section_pool.append(section)

    section_pool = _aa_candidate_course_order(section_pool, ctx, course_history)
    print("[AA DEBUG] total sections in pool =", len(section_pool))
    print("[AA DEBUG] protected sections =", len(protected_section_ids or set()))
    print("[AA DEBUG] FT faculty count =", len([f for f in faculty_states if (f.get("employment_type") or "").upper() == "FT"]))
    print("[AA DEBUG] PT faculty count =", len([f for f in faculty_states if (f.get("employment_type") or "").upper() == "PT"]))
    print("[AA DEBUG] history courses loaded =", len(course_history or {}))
    print("[AA DEBUG] KAC course map size =", len((getattr(ctx, "course_to_kacs", {}) or {})))
    ctx.protected_section_ids = set(protected_section_ids)
    assignments: list[dict] = []
    trace: list[dict] = []

    def remaining() -> list[dict]:
        assigned_ids = {a["section_id"] for a in assignments}
        return [sec for sec in section_pool if sec["section_id"] not in assigned_ids]

    ft_states = [s for s in faculty_states if s["employment_type"] == "FT"]
    pt_states = [s for s in faculty_states if s["employment_type"] == "PT"]

    # Round 1: FT minimum via history, 1 section per faculty per pass
    while True:
        progress = False
        active_ft = sorted([s for s in ft_states if s["total_credited_units"] < 12], key=lambda s: (s["total_credited_units"], s["assigned_teaching_units"], s["faculty_id"]))
        if not active_ft:
            break
        rem = remaining()
        if not rem:
            break
        for fstate in active_ft:
            print(f"[ROUND1] fac={fstate['faculty_id']} total_units={fstate.get('total_credited_units', 0)} teaching={fstate.get('assigned_teaching_units', 0)}")
            latest_candidates = _aa_history_candidates_for_faculty(fstate, rem, course_history, latest_only=True)
            print(f"[ROUND1] fac={fstate['faculty_id']} latest_history_candidates={len(latest_candidates)} candidate_section_ids={[s.get('section_id') for s in latest_candidates[:10]]}")
            sec = None
            reason = None
            for cand in latest_candidates:
                if _aa_faculty_can_take_section(fstate, cand, ctx):
                    sec = cand
                    reason = "recent_history"
                    break
            if sec is None:
                older_candidates = _aa_history_candidates_for_faculty(fstate, rem, course_history, latest_only=False)
                print(f"[ROUND1] fac={fstate['faculty_id']} older_history_candidates={len(older_candidates)} candidate_section_ids={[s.get('section_id') for s in older_candidates[:10]]}")
                for cand in older_candidates:
                    if _aa_faculty_can_take_section(fstate, cand, ctx):
                        sec = cand
                        reason = "older_history"
                        break
            if sec is None:
                print(f"[ROUND1 MISS] fac={fstate['faculty_id']} no valid history-based section assigned")
                continue
            _aa_assign_section(fstate, sec, reason or "older_history", "round1_ft_history", trace, assignments)
            rem = remaining()
            progress = True
        if not progress:
            break

    assigned_now = sum(1 for s in section_pool if s["section_id"] in {a["section_id"] for a in assignments})
    unassigned_now = len(section_pool) - assigned_now
    print(f"[AA STAGE DONE] stage=round1_history assigned={assigned_now} unassigned={unassigned_now}")

    # Round 2a: FT minimum via KAC fallback
    while True:
        progress = False
        rem = remaining()
        if not rem:
            break
        for fstate in sorted([s for s in ft_states if s["total_credited_units"] < 12], key=lambda s: (s["total_credited_units"], s["faculty_id"])):
            sec = _aa_pick_kac_section(fstate, rem, ctx)
            if sec is None or not _aa_faculty_can_take_section(fstate, sec, ctx):
                continue
            _aa_assign_section(fstate, sec, "kac_fallback", "round2_ft_kac", trace, assignments)
            rem = remaining()
            progress = True
        if not progress:
            break

    assigned_now = sum(1 for s in section_pool if s["section_id"] in {a["section_id"] for a in assignments})
    unassigned_now = len(section_pool) - assigned_now
    print(f"[AA STAGE DONE] stage=round2_ft_kac assigned={assigned_now} unassigned={unassigned_now}")

    # Round 2b: FT extra loads up to desired teaching ceiling
    while True:
        progress = False
        rem = remaining()
        if not rem:
            break
        for fstate in sorted(ft_states, key=lambda s: (s["assigned_teaching_units"], s["faculty_id"])):
            if fstate["assigned_teaching_units"] >= fstate["desired_teaching_units"]:
                continue
            sec = _aa_pick_history_section(fstate, rem, course_history, latest_only=False)
            reason = "ft_extra_history"
            if sec is None:
                sec = _aa_pick_kac_section(fstate, rem, ctx)
                reason = "ft_extra_kac"
            if sec is None or not _aa_faculty_can_take_section(fstate, sec, ctx):
                continue
            if fstate["assigned_teaching_units"] + int(sec.get("units") or 0) > fstate["desired_teaching_units"]:
                continue
            _aa_assign_section(fstate, sec, reason, "round2_ft_extra", trace, assignments)
            rem = remaining()
            progress = True
        if not progress:
            break

    assigned_now = sum(1 for s in section_pool if s["section_id"] in {a["section_id"] for a in assignments})
    unassigned_now = len(section_pool) - assigned_now
    print(f"[AA STAGE DONE] stage=round3_ft_extra assigned={assigned_now} unassigned={unassigned_now}")

    # Round 3: PT assignment
    while True:
        progress = False
        rem = remaining()
        if not rem:
            break
        for pstate in sorted(pt_states, key=lambda s: (s["assigned_teaching_units"], s["faculty_id"])):
            sec, reason = _aa_pick_pt_section(pstate, rem, course_history, ctx)
            if sec is None:
                continue
            _aa_assign_section(pstate, sec, reason or "pt_kac", "round3_pt", trace, assignments)
            rem = remaining()
            progress = True
        if not progress:
            break

    assigned_now = sum(1 for s in section_pool if s["section_id"] in {a["section_id"] for a in assignments})
    unassigned_now = len(section_pool) - assigned_now
    print(f"[AA STAGE DONE] stage=round4_pt assigned={assigned_now} unassigned={unassigned_now}")

    # Round 4: rescue remaining blanks -> history again, PT kac, FT overload last
    rem = remaining()
    for sec in rem:
        chosen = None
        reason = None
        for hist in course_history.get(sec["course_id"], []):
            fid = hist.get("faculty_id")
            fstate = faculty_state_by_id.get(fid)
            if fstate and _aa_faculty_can_take_section(fstate, sec, ctx, require_pref_for_pt=(fstate["employment_type"] == "PT")):
                chosen = fstate
                reason = "history_rescue"
                break
        if chosen is None:
            for pstate in pt_states:
                cand = _aa_pick_kac_section(pstate, [sec], ctx)
                if cand is not None and _aa_faculty_can_take_section(pstate, sec, ctx, require_pref_for_pt=True):
                    chosen = pstate
                    reason = "pt_kac"
                    break
        if chosen is None:
            for fstate in sorted(ft_states, key=lambda s: (s["total_credited_units"], s["faculty_id"])):
                if _aa_faculty_can_take_section(fstate, sec, ctx):
                    chosen = fstate
                    reason = "rescue_overload"
                    break
        if chosen is not None:
            _aa_assign_section(chosen, sec, reason or "rescue_overload", "round4_rescue", trace, assignments)

    assigned_now = sum(1 for s in section_pool if s["section_id"] in {a["section_id"] for a in assignments})
    unassigned_now = len(section_pool) - assigned_now
    print(f"[AA STAGE DONE] stage=round5_rescue assigned={assigned_now} unassigned={unassigned_now}")

    debug = _aa_rebalance_max_preps(assignments, section_lookup, faculty_states, faculty_state_by_id, ctx, trace)
    debug.update(_aa_assign_schedule(assignments, section_lookup, faculty_state_by_id, ctx, schedule_history, trace))
    debug.update({
        "assignment_trace": trace,
        "protected_section_ids": sorted(protected_section_ids),
        "remaining_unassigned_sections": [s["section_id"] for s in remaining()],
    })
    print("[AA FINAL] total rows =", len(section_pool))
    print("[AA FINAL] assigned rows =", len(assignments))
    print("[AA FINAL] unassigned rows =", len(section_pool) - len(assignments))
    print("[AA FINAL] assignment_trace count =", len(trace))
    return {
        "term_id": term_id,
        "courses_order": [s["course_id"] for s in section_pool],
        "by_course": {},
        "assignments": assignments,
        "debug": debug,
    }


async def compute_load_recommendations(
    term_id: str,
    db,
    *,
    department_id: str | None = None,
    respect_locks: bool = True,
    protected_section_ids: set[str] | None = None,
    source_rows: list[dict] | None = None,
) -> dict:
    return await _compute_load_recommendations_v2(
        term_id,
        db,
        department_id=department_id,
        protected_section_ids=protected_section_ids if respect_locks else set(),
        source_rows=source_rows,
    )


# ================== END NEW AUTO-ASSIGNMENT ENGINE ==================
