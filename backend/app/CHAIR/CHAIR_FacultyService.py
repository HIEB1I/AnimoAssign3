# backend/app/CHAIR/CHAIR_FacultyService.py
# -----------------------------------------------------------------------------
# Collections used:
#   - faculty_service    : stores request/response records
#   - courses            : course lookups (by course_code), filtered by department if provided
#   - faculty_profiles   : faculty dropdown (by receiving department)
#   - users              : fetch faculty email
#   - email_logs         : stub for outbound emails
# -----------------------------------------------------------------------------

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import uuid4
import re

from fastapi import APIRouter, Body, HTTPException, Query
from ..main import db
from ..Notifications import create_notification

router = APIRouter(prefix="/chair/faculty-service", tags=["chair", "faculty-service"])

# --- collections for term logic ---
COL_TERMS = "terms"
COL_PREEN_COUNT = "preenlistment_count"

# OM collections (for reflecting accepted faculty-service into OM Load Assignment)
COL_SECTIONS_SUBMITTED = "sections_submitted"
COL_SECTIONS = "sections"
COL_SCHED = "section_schedules"
COL_ASSIGN = "faculty_assignments"

# --- constants per spec ---
DAYS = ["M", "T", "W", "H", "F", "S"]
BEGIN = ["07:30", "09:15", "11:00", "12:45", "14:30", "16:15", "18:00", "19:45"]
END_BY_BEGIN = {

    "07:30": "09:00",
    "09:15": "10:45",
    "11:00": "12:30",
    "12:45": "14:15",
    "14:30": "16:00",
    "16:15": "17:45",
    "18:00": "19:30",
    "19:45": "21:00",
}

# Department directory
# NOTE: Previously these were hardcoded (DEPTS/RECIPIENT). We now prefer the `departments`
# collection/table as the source of truth, with a backwards-compatible fallback.
DEFAULT_DEPTS = [
    "Department of Computer Technology",
    "Department of Information Technology",
    "Department of Literature",
    "Department of Software Technology",
]

async def _list_departments() -> list[dict]:
    """Return departments from DB (sorted by name).

    Falls back to DEFAULT_DEPTS when the collection isn't available or empty.
    """
    try:
        cur = db.departments.find(
            {},
            {"_id": 0, "department_id": 1, "dept_name": 1, "dept_code": 1},
        ).sort([("dept_name", 1)])
        rows = [d async for d in cur]
        if rows:
            return rows
    except Exception:
        pass

    return [{"department_id": None, "dept_name": n, "dept_code": ""} for n in DEFAULT_DEPTS]

async def _list_department_names() -> list[str]:
    rows = await _list_departments()
    names = [r.get("dept_name") for r in rows if r.get("dept_name")]
    out: list[str] = []
    seen = set()
    for n in names:
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out

async def _canon_dept_name(name: str | None) -> str:
    """Return the canonical department name.

    - Prefers the `departments` collection/table (dept_name) when available.
    - Falls back to DEFAULT_DEPTS (case/space tolerant).
    - If no match is found, returns the stripped input (or empty string).
    """
    s = (name or "").strip()
    if not s:
        return ""

    try:
        d = await _find_department(s)
        if d and d.get("dept_name"):
            return d["dept_name"]
    except Exception:
        pass

    s_norm = " ".join(s.lower().split())
    for d in DEFAULT_DEPTS:
        if " ".join(d.lower().split()) == s_norm:
            return d

    return s

# ------------------------ helpers ------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ------------------------ stale/restore guards ------------------------

def _coerce_dt(v: Any) -> Optional[datetime]:
    """Best-effort parse for datetimes stored as datetime/ISO string/epoch seconds."""
    if v is None:
        return None
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if isinstance(v, (int, float)):
        try:
            if v > 1_000_000_000_000:
                return datetime.fromtimestamp(v / 1000.0, tz=timezone.utc)
            return datetime.fromtimestamp(v, tz=timezone.utc)
        except Exception:
            return None
    s = str(v).strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
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


def _doc_ts(doc: Dict[str, Any]) -> Optional[datetime]:
    return _pick_dt(doc, ["updated_at", "created_at", "createdAt", "updatedAt"])


def _section_ts(sec_doc: Dict[str, Any]) -> Optional[datetime]:
    # sections_submitted/sections may store any of these fields depending on import path
    return _pick_dt(sec_doc, ["imported_at", "created_at", "createdAt", "updated_at", "updatedAt"])


async def _active_term() -> Dict[str, Any]:
    """
    Shared WORKING / PLANNING term logic (OM-style).

    Returns a dict with at least:
      - term_id
      - acad_year_start
      - term_number

    Selection rules:

      (a) Prefer active pre-enlistment batch
          - Look up in preenlistment_count where is_archived != True.
          - If it has a term_id and that term exists in terms, return that term.

      (b) Otherwise, find the “current” term
          - Query terms where any of these flags indicate it's current:
              status: "active" or "Active"
              is_current: True
              is_active: True
              active: True
          - Project only term_id, acad_year_start, term_number.
          - If none match, fall back to the latest term by
              acad_year_start DESC, term_number DESC.

      (c) If still nothing
          - If there are no terms at all, return {} (empty dict).

      (d) Compute the planning term (next term)
          - Given the current term from step (b), try to find the next term:
              acad_year_start > current.acad_year_start, OR
              acad_year_start == current.acad_year_start
                AND term_number > current.term_number
          - Sort by acad_year_start ASC, term_number ASC and take the first result.
          - If a “next” term exists, return that as the working / planning term.
          - If no next term exists, return the current term.
    """

    # (a) Prefer active pre-enlistment batch
    pre_doc = await db[COL_PREEN_COUNT].find_one(
        {"is_archived": {"$ne": True}},
        {"_id": 0, "term_id": 1},
    )
    if pre_doc and pre_doc.get("term_id"):
        t = await db[COL_TERMS].find_one(
            {"term_id": pre_doc["term_id"]},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        )
        if t:
            return t

    # (b) Otherwise, find the “current” term via flags
    current = await db[COL_TERMS].find_one(
        {
            "$or": [
                {"status": "active"},
                {"status": "Active"},
                {"is_current": True},
                {"is_active": True},
                {"active": True},
            ]
        },
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )

    # Fallback: latest by acad_year_start DESC, term_number DESC
    if not current:
        last = await db[COL_TERMS].find(
            {},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        ).sort([("acad_year_start", -1), ("term_number", -1)]).limit(1).to_list(1)
        current = last[0] if last else None

    # (c) If still nothing, no terms at all
    if not current:
        return {}

    # (d) Compute the planning term (next term)
    next_terms = await db[COL_TERMS].find(
        {
            "$or": [
                {"acad_year_start": {"$gt": current["acad_year_start"]}},
                {
                    "acad_year_start": current["acad_year_start"],
                    "term_number": {"$gt": current["term_number"]},
                },
            ]
        },
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    ).sort([("acad_year_start", 1), ("term_number", 1)]).limit(1).to_list(1)

    if next_terms:
        return next_terms[0]

    # If no next term exists, return the current/latest term
    return current


def _normalize_code(code: Any) -> str:
    if isinstance(code, list):
        return (code[0] or "").upper()
    return str(code or "").upper()


async def _find_department(query: str) -> Optional[Dict[str, Any]]:
    """Find a department by name/code/id.

    IMPORTANT: be tolerant of case differences and leading/trailing spaces.
    """
    q = (query or "").strip()
    if not q:
        return None

    # 1) Exact match (fast)
    doc = await db.departments.find_one(
        {"$or": [{"dept_name": q}, {"dept_code": q}, {"department_id": q}]},
        {"_id": 0, "department_id": 1, "dept_name": 1, "dept_code": 1},
    )
    if doc:
        return doc

    # 2) Case-insensitive exact match for name/code
    doc = await db.departments.find_one(
        {
            "$or": [
                {"dept_name": {"$regex": f"^{q}$", "$options": "i"}},
                {"dept_code": {"$regex": f"^{q}$", "$options": "i"}},
            ]
        },
        {"_id": 0, "department_id": 1, "dept_name": 1, "dept_code": 1},
    )
    return doc

async def _chair_user_ids_for_dept(dept_name: str | None) -> list[str]:
    """Resolve department chair user_id(s) for a given department.

    Replaces the old hardcoded RECIPIENT mapping.

    Resolution strategy (most reliable first):
      1) role_assignments scoped to the department, where role_type contains "chair"
      2) staff_profiles where department matches and position_title contains "chair" (if present)

    Returns a de-duplicated list. If nothing matches, returns [].
    """

    dept_name = await _canon_dept_name(dept_name)
    if not dept_name:
        return []

    dept = await _find_department(dept_name)
    dep_id = (dept or {}).get("department_id")
    dep_code = (dept or {}).get("dept_code")

    ids: list[str] = []

    # 1) role_assignments using scope (preferred)
    try:
        chair_roles: list[str] = []
        cur_roles = db.user_roles.find(
            {"role_type": {"$regex": "chair", "$options": "i"}},
            {"_id": 0, "role_id": 1},
        )
        async for r in cur_roles:
            if r.get("role_id"):
                chair_roles.append(r["role_id"])

        if chair_roles:
            scope_or: list[dict] = []
            if dep_id:
                scope_or.append({"scope": {"$elemMatch": {"type": "department", "id": dep_id}}})
            if dep_code:
                scope_or.append({"scope": {"$elemMatch": {"type": "department", "id": dep_code}}})
            scope_or.append({"scope": {"$elemMatch": {"type": "department", "id": dept_name}}})

            q = {"role_id": {"$in": chair_roles}, "$or": scope_or}
            cur_ra = db.role_assignments.find(q, {"_id": 0, "user_id": 1})
            async for d in cur_ra:
                if d.get("user_id"):
                    ids.append(d["user_id"])
    except Exception:
        pass

    # 2) staff_profiles fallback (older schema)
    if not ids:
        try:
            match_or: list[dict] = []
            if dep_id:
                match_or += [{"department_id": dep_id}, {"dept_id": dep_id}]
            match_or += [
                {"dept_name": {"$regex": f"^{dept_name}$", "$options": "i"}},
                {"department": {"$regex": f"^{dept_name}$", "$options": "i"}},
                {"department_name": {"$regex": f"^{dept_name}$", "$options": "i"}},
            ]
            cur = db.staff_profiles.find(
                {"$or": match_or, "position_title": {"$regex": "chair", "$options": "i"}},
                {"_id": 0, "user_id": 1},
            )
            async for d in cur:
                if d.get("user_id"):
                    ids.append(d["user_id"])
        except Exception:
            pass

    # de-dupe while preserving order
    out: list[str] = []
    seen = set()
    for uid in ids:
        if uid and uid not in seen:
            seen.add(uid)
            out.append(uid)
    return out


async def _chair_contacts_for_dept(dept_name: str | None) -> list[dict]:
    """Return chair contacts (user_id, full_name, email) for a department."""
    ids = await _chair_user_ids_for_dept(dept_name)
    if not ids:
        return []

    out: list[dict] = []
    try:
        cur = db.users.find(
            {"user_id": {"$in": ids}},
            {"_id": 0, "user_id": 1, "first_name": 1, "last_name": 1, "email": 1},
        )
        users = [u async for u in cur]
        by_id = {u.get("user_id"): u for u in users}
        for uid in ids:
            u = by_id.get(uid) or {}
            fn = (u.get("first_name") or "").strip()
            ln = (u.get("last_name") or "").strip()
            full = (f"{fn} {ln}").strip() or uid
            out.append({"user_id": uid, "full_name": full, "email": (u.get("email") or "").strip()})
    except Exception:
        out = [{"user_id": uid, "full_name": uid, "email": ""} for uid in ids]

    return out


async def _om_user_ids_for_dept(dept_name: str | None) -> list[str]:
    """Resolve Office Manager (OM) user_id(s) for a given department.

    Faculty Service syncing writes into OM Load Assignment sources (assignments/schedules/remarks).
    When a request is accepted/responded, OM(s) for the requesting department should be notified.

    Strategy (robust across schema variants):
      1) Legacy role_assignments with role in {office_manager, om} and department_id(s)
      2) role-based resolution: user_roles(role_type contains om/office manager) -> role_assignments scoped to department
      3) staff_profiles fallback: department match + position_title contains om/office manager

    Returns a de-duplicated list. If nothing matches, returns [].
    """

    dept_name = await _canon_dept_name(dept_name)
    if not dept_name:
        return []

    dept = await _find_department(dept_name)
    dep_id = (dept or {}).get("department_id")
    dep_code = (dept or {}).get("dept_code")

    ids: list[str] = []

    # 1) Legacy role_assignments(role=office_manager/om) with department_id(s)
    try:
        dept_or: list[dict] = []
        if dep_id:
            dept_or += [
                {"department_id": dep_id},
                {"department_ids": dep_id},
                {"department_ids": {"$in": [dep_id]}},
            ]
        if dep_code:
            dept_or += [
                {"department_id": dep_code},
                {"department_ids": dep_code},
                {"department_ids": {"$in": [dep_code]}},
            ]
        # dept name as a last resort (some DBs store this string directly)
        dept_or.append({"department_id": dept_name})
        dept_or.append({"department_ids": dept_name})
        dept_or.append({"department_ids": {"$in": [dept_name]}})

        q = {
            "role": {"$in": ["office_manager", "om"]},
            "$or": dept_or,
        }
        cur = db.role_assignments.find(q, {"_id": 0, "user_id": 1})
        async for d in cur:
            if d.get("user_id"):
                ids.append(d["user_id"])
    except Exception:
        pass

    # 2) Newer role-based system: user_roles(role_type contains om/office manager)
    if not ids:
        try:
            om_role_ids: list[str] = []
            cur_roles = db.user_roles.find(
                {"role_type": {"$regex": "(office[_ ]?manager|\\bom\\b)", "$options": "i"}},
                {"_id": 0, "role_id": 1},
            )
            async for r in cur_roles:
                if r.get("role_id"):
                    om_role_ids.append(r["role_id"])

            if om_role_ids:
                scope_or: list[dict] = []
                if dep_id:
                    scope_or.append({"scope": {"$elemMatch": {"type": "department", "id": dep_id}}})
                if dep_code:
                    scope_or.append({"scope": {"$elemMatch": {"type": "department", "id": dep_code}}})
                scope_or.append({"scope": {"$elemMatch": {"type": "department", "id": dept_name}}})

                q = {"role_id": {"$in": om_role_ids}, "$or": scope_or}
                cur_ra = db.role_assignments.find(q, {"_id": 0, "user_id": 1})
                async for d in cur_ra:
                    if d.get("user_id"):
                        ids.append(d["user_id"])
        except Exception:
            pass

    # 3) staff_profiles fallback (older schema)
    if not ids:
        try:
            match_or: list[dict] = []
            if dep_id:
                match_or += [{"department_id": dep_id}, {"dept_id": dep_id}]
            match_or += [
                {"dept_name": {"$regex": f"^{dept_name}$", "$options": "i"}},
                {"department": {"$regex": f"^{dept_name}$", "$options": "i"}},
                {"department_name": {"$regex": f"^{dept_name}$", "$options": "i"}},
            ]

            cur = db.staff_profiles.find(
                {
                    "$or": match_or,
                    "position_title": {"$regex": "(office[_ ]?manager|\\bom\\b)", "$options": "i"},
                },
                {"_id": 0, "user_id": 1},
            )
            async for d in cur:
                if d.get("user_id"):
                    ids.append(d["user_id"])
        except Exception:
            pass

    # de-dupe while preserving order
    out: list[str] = []
    seen = set()
    for uid in ids:
        if uid and uid not in seen:
            seen.add(uid)
            out.append(uid)
    return out


async def _course_by_code(code: str) -> Optional[Dict[str, Any]]:
    if not code:
        return None
    doc = await db.courses.find_one(
        {"$or": [{"course_code": code}, {"course_code": [code]}]},
        {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1, "units": 1, "department_id": 1},
    )
    if not doc:
        # fallback regex
        doc = await db.courses.find_one(
            {"$or": [{"course_code": {"$regex": f"^{code}$", "$options": "i"}},
                     {"course_code": {"$in": [code]}}]},
            {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1, "units": 1, "department_id": 1},
        )
    if doc:
        doc["course_code"] = _normalize_code(doc.get("course_code"))
    return doc


def _sch_id_from_sec(section_id: str, slot: int = 1) -> str:
    """Match OM schedule_id scheme so OM Load Assignment reflects changes."""
    m = re.match(r"^SEC(\d+)$", (section_id or "").strip().upper())
    if m:
        return f"SCH{int(m.group(1)):04d}-{int(slot):02d}"
    return f"SCH-{section_id}-{int(slot)}"


def _asg_id_from_sec(section_id: str) -> str:
    """Match OM assignment_id scheme."""
    m = re.match(r"^SEC(\d+)$", (section_id or "").strip().upper())
    if m:
        return f"ASG{int(m.group(1)):04d}"
    return f"ASG{uuid4().hex[:10].upper()}"


async def _reflect_faculty_service_to_om(row: Dict[str, Any], update: Dict[str, Any]) -> None:
    """Propagate an accepted faculty-service response into OM Load Assignment.

    OM Load Assignment list is sourced from:
      - sections_submitted (row universe)
      - section_schedules (day/begin/end/room)
      - faculty_assignments (faculty_id)
      - sections (remarks)

    Faculty Service requests are keyed by course_code (picked from OM rows), so we update
    all submitted sections that match the requesting department + course_code in the active
    OM working/planning term.
    """

    # Resolve active/planning term (same logic used by Faculty Service options)
    active = await _active_term()
    term_id = (active or {}).get("term_id")
    if not term_id:
        return

    course_code = _normalize_code(row.get("course_code"))
    if not course_code:
        return

    requested_section_id = str(row.get("section_id") or "").strip()

    from_dept_name = await _canon_dept_name(row.get("from_department"))
    from_dept = await _find_department(from_dept_name) if from_dept_name else None
    from_dept_id = (from_dept or {}).get("department_id")

    # Locate course_id for the requested course (prefer scoping to requesting dept if possible)
    course_doc = await db.courses.find_one(
        {
            "$and": [
                {"$or": [{"course_code": course_code}, {"course_code": [course_code]}]},
                *([{"department_id": from_dept_id}] if from_dept_id else []),
            ]
        },
        {"_id": 0, "course_id": 1},
    )
    if not course_doc:
        # fallback: existing helper (no dept scope)
        course_doc = await _course_by_code(course_code)

    course_id = (course_doc or {}).get("course_id")
    if not course_id:
        return

    # Prefer a specific section_id (if the request was created with Section dropdown)
    requested_section_id = str(row.get("section_id") or "").strip()

    # Find submitted sections for this (term, course). If a specific section was requested,
    # validate it exists for this term/course; otherwise fall back to the old behavior
    # (update all matching sections) for backwards compatibility.
    match: Dict[str, Any] = {"term_id": term_id, "submitted_for_scheduling": True, "course_id": course_id}

    section_ids: List[str] = []
    if requested_section_id:
        ok_sec = await db[COL_SECTIONS_SUBMITTED].find_one(
            {**match, "section_id": requested_section_id},
            {"_id": 0, "section_id": 1},
        )
        if ok_sec and (ok_sec.get("section_id") or "").strip():
            section_ids = [requested_section_id]

    if not section_ids:
        sec_docs = await db[COL_SECTIONS_SUBMITTED].find(match, {"_id": 0, "section_id": 1}).to_list(None)
        section_ids = [str(d.get("section_id") or "").strip() for d in (sec_docs or [])]
        section_ids = [sid for sid in section_ids if sid]
        if not section_ids:
            return

    ts = datetime.now(timezone.utc)

    faculty = (update.get("faculty") or {}) if isinstance(update.get("faculty"), dict) else {}
    faculty_id = str(faculty.get("faculty_id") or "").strip()

    day1 = str(update.get("day1") or "").strip()
    begin1 = str(update.get("begin1") or "").strip()
    end1 = str(update.get("end1") or "").strip()
    day2 = str(update.get("day2") or "").strip()
    begin2 = str(update.get("begin2") or "").strip()
    end2 = str(update.get("end2") or "").strip()
    remarks = str(update.get("remarks") or "").strip()

    for sid in section_ids:
        # 1) Faculty assignment (upsert)
        if faculty_id:
            await db[COL_ASSIGN].update_one(
                {"section_id": sid, "is_archived": {"$ne": True}},
                {
                    "$set": {
                        "section_id": sid,
                        "faculty_id": faculty_id,
                        "updated_at": ts,
                        "is_archived": False,
                        "synced_from_faculty_service": True,
                        "synced_from_faculty_service_at": ts,
                    },
                    "$setOnInsert": {
                        "assignment_id": _asg_id_from_sec(sid),
                        "user_id": "",
                        "created_at": ts,
                    },
                },
                upsert=True,
            )

        # 2) Schedule slots (upsert). Keep room_id untouched unless inserting.
        await db[COL_SCHED].update_one(
            {"section_id": sid, "schedule_id": _sch_id_from_sec(sid, 1)},
            {
                "$set": {
                    "schedule_id": _sch_id_from_sec(sid, 1),
                    "section_id": sid,
                    "day": day1 or None,
                    "start_time": begin1 or None,
                    "end_time": end1 or None,
                    "updated_at": ts,
                },
                "$setOnInsert": {"created_at": ts},
            },
            upsert=True,
        )
        await db[COL_SCHED].update_one(
            {"section_id": sid, "schedule_id": _sch_id_from_sec(sid, 2)},
            {
                "$set": {
                    "schedule_id": _sch_id_from_sec(sid, 2),
                    "section_id": sid,
                    "day": day2 or None,
                    "start_time": begin2 or None,
                    "end_time": end2 or None,
                    "updated_at": ts,
                },
                "$setOnInsert": {"created_at": ts},
            },
            upsert=True,
        )

        # 3) Remarks live on the canonical `sections` collection.
        # We preserve the previous remarks so we can revert when an Approved request
        # is later changed to Rejected/Pending.
        if remarks is not None:
            try:
                prev_doc = await db[COL_SECTIONS].find_one(
                    {"section_id": sid},
                    {"_id": 0, "remarks": 1, "synced_from_faculty_service_remarks": 1, "synced_from_faculty_service_prev_remarks": 1},
                )
            except Exception:
                prev_doc = None

            already_synced = bool((prev_doc or {}).get("synced_from_faculty_service_remarks"))
            prev_remarks = (prev_doc or {}).get("remarks", "") if not already_synced else (prev_doc or {}).get(
                "synced_from_faculty_service_prev_remarks", ""
            )

            set_fields: Dict[str, Any] = {
                "remarks": remarks,
                "updated_at": ts,
                "synced_from_faculty_service_remarks": True,
                "synced_from_faculty_service_remarks_at": ts,
            }
            if not already_synced:
                set_fields["synced_from_faculty_service_prev_remarks"] = prev_remarks

            await db[COL_SECTIONS].update_one(
                {"section_id": sid},
                {"$set": set_fields, "$setOnInsert": {"created_at": ts}},
                upsert=True,
            )


async def _target_section_ids_for_faculty_service_row(row: Dict[str, Any]) -> List[str]:
    """Resolve which submitted section_id(s) in the active/planning term should be affected
    by a faculty service request.

    Mirrors the targeting logic of _reflect_faculty_service_to_om().
    """

    active = await _active_term()
    term_id = (active or {}).get("term_id")
    if not term_id:
        return []

    course_code = _normalize_code(row.get("course_code"))
    if not course_code:
        return []

    from_dept_name = await _canon_dept_name(row.get("from_department"))
    from_dept = await _find_department(from_dept_name) if from_dept_name else None
    from_dept_id = (from_dept or {}).get("department_id")

    course_doc = await db.courses.find_one(
        {
            "$and": [
                {"$or": [{"course_code": course_code}, {"course_code": [course_code]}]},
                *([{"department_id": from_dept_id}] if from_dept_id else []),
            ]
        },
        {"_id": 0, "course_id": 1},
    )
    if not course_doc:
        course_doc = await _course_by_code(course_code)

    course_id = (course_doc or {}).get("course_id")
    if not course_id:
        return []

    requested_section_id = str(row.get("section_id") or "").strip()
    match: Dict[str, Any] = {"term_id": term_id, "submitted_for_scheduling": True, "course_id": course_id}

    section_ids: List[str] = []
    if requested_section_id:
        ok_sec = await db[COL_SECTIONS_SUBMITTED].find_one(
            {**match, "section_id": requested_section_id},
            {"_id": 0, "section_id": 1},
        )
        if ok_sec and (ok_sec.get("section_id") or "").strip():
            section_ids = [requested_section_id]

    if not section_ids:
        sec_docs = await db[COL_SECTIONS_SUBMITTED].find(match, {"_id": 0, "section_id": 1}).to_list(None)
        section_ids = [str(d.get("section_id") or "").strip() for d in (sec_docs or [])]
        section_ids = [sid for sid in section_ids if sid]

    return section_ids


async def _unreflect_faculty_service_from_om(row: Dict[str, Any]) -> None:
    """Undo faculty assignment reflections into OM Load Assignment.

    Requirement: If a previously Approved (responded) request is later changed to Rejected (or Pending),
    the corresponding Load Assignment row(s) should revert to having *no assigned faculty*.

    We only remove assignments that were created/updated by Faculty Service syncing.
    """

    section_ids = await _target_section_ids_for_faculty_service_row(row)
    if not section_ids:
        return

    # 1) Remove synced faculty assignments
    try:
        await db[COL_ASSIGN].delete_many({"section_id": {"$in": section_ids}, "synced_from_faculty_service": True})
    except Exception:
        pass

    # 2) Revert remarks that were set via faculty-service syncing
    # (Only revert when we previously marked the remarks as synced.)
    for sid in section_ids:
        try:
            sdoc = await db[COL_SECTIONS].find_one(
                {"section_id": sid},
                {"_id": 0, "synced_from_faculty_service_remarks": 1, "synced_from_faculty_service_prev_remarks": 1},
            )
            if not sdoc or not sdoc.get("synced_from_faculty_service_remarks"):
                continue
            prev_remarks = sdoc.get("synced_from_faculty_service_prev_remarks", "")
            await db[COL_SECTIONS].update_one(
                {"section_id": sid},
                {
                    "$set": {"remarks": prev_remarks, "updated_at": datetime.now(timezone.utc)},
                    "$unset": {
                        "synced_from_faculty_service_remarks": "",
                        "synced_from_faculty_service_remarks_at": "",
                        "synced_from_faculty_service_prev_remarks": "",
                    },
                },
            )
        except Exception:
            # Fail silently so Chair workflow doesn't break even if OM data is missing
            continue


async def _faculty_dropdown(dept_name: Optional[str]) -> List[Dict[str, Any]]:
    if not dept_name:
        return []

    # Find department_id from any of (name / code / id)
    dept = await _find_department(dept_name)
    dep_id = (dept or {}).get("department_id")
    if not dep_id:
        return []

    pipeline = [
        {"$match": {"department_id": dep_id}},
        {
            "$lookup": {
                "from": "users",
                "localField": "user_id",
                "foreignField": "user_id",
                "as": "u",
            }
        },
        {
            "$addFields": {
                "user": {"$arrayElemAt": ["$u", 0]},
            }
        },
        {
            "$project": {
                "_id": 0,
                "faculty_id": 1,
                "user_id": 1,
                "first_name": {"$ifNull": ["$user.first_name", ""]},
                "last_name": {"$ifNull": ["$user.last_name", ""]},
            }
        },
        {"$sort": {"last_name": 1, "first_name": 1}},
    ]

    out: List[Dict[str, Any]] = []
    async for r in db.faculty_profiles.aggregate(pipeline):
        out.append(
            {
                "faculty_id": r.get("faculty_id"),
                "first_name": r.get("first_name") or "",
                "last_name": r.get("last_name") or "",
                "label": f"{(r.get('last_name') or '').upper()}, {(r.get('first_name') or '').upper()}",
            }
        )
    return out




def _time_to_minutes(value: Any) -> Optional[int]:
    s = str(value or '').strip()
    if not s:
        return None
    if re.fullmatch(r"\d{1,2}:\d{2}", s):
        hh, mm = s.split(':', 1)
        try:
            h = int(hh)
            m = int(mm)
            if 0 <= h <= 23 and 0 <= m <= 59:
                return h * 60 + m
        except Exception:
            return None
    digits = re.sub(r"\D", "", s)
    if len(digits) == 3:
        digits = '0' + digits
    if len(digits) == 4:
        try:
            h = int(digits[:2])
            m = int(digits[2:])
            if 0 <= h <= 23 and 0 <= m <= 59:
                return h * 60 + m
        except Exception:
            return None
    return None


def _normalize_day_short(value: Any) -> str:
    raw = str(value or '').strip().upper()
    if not raw:
        return ''
    if raw in {'M', 'T', 'W', 'H', 'F', 'S'}:
        return raw
    if raw in {'TH', 'THU', 'THUR', 'THURS', 'THURSDAY'}:
        return 'H'
    if raw.startswith('MON'):
        return 'M'
    if raw.startswith('TUE'):
        return 'T'
    if raw.startswith('WED'):
        return 'W'
    if raw.startswith('FRI'):
        return 'F'
    if raw.startswith('SAT'):
        return 'S'
    return raw[:1]


def _ranges_overlap(begin_a: int, end_a: int, begin_b: int, end_b: int) -> bool:
    return begin_a < end_b and begin_b < end_a


def _meeting_slots_from_payload(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for suffix in ('1', '2'):
        day = _normalize_day_short(payload.get(f'day{suffix}'))
        begin = str(payload.get(f'begin{suffix}') or '').strip()
        end = str(payload.get(f'end{suffix}') or '').strip()
        if begin and not end:
            end = END_BY_BEGIN.get(begin, end)
        b = _time_to_minutes(begin)
        e = _time_to_minutes(end)
        if day and b is not None and e is not None and e > b:
            out.append({
                'day': day,
                'begin': begin,
                'end': end,
                'begin_minutes': b,
                'end_minutes': e,
            })
    return out


async def _faculty_busy_slots(term_id: str, faculty_ids: List[str], db) -> Dict[str, List[Dict[str, str]]]:
    term_id = str(term_id or '').strip()
    faculty_ids = [str(fid or '').strip() for fid in (faculty_ids or []) if str(fid or '').strip()]
    if not term_id or not faculty_ids:
        return {}

    result: Dict[str, List[Dict[str, str]]] = {fid: [] for fid in faculty_ids}

    # IMPORTANT:
    # Existing OM rows are not guaranteed to persist `faculty_assignments.term_id`.
    # Some data sets only key assignments by section_id, while the term is carried by
    # `sections_submitted` / `sections` / `section_schedules`.
    #
    # So we first pull all active assignments for the faculty, then keep only section_ids
    # that belong to the requested term using the section/schedule collections.
    cur = db[COL_ASSIGN].find(
        {
            'faculty_id': {'$in': faculty_ids},
            'is_archived': {'$ne': True},
            'faculty_id': {'$nin': [None, ''], '$in': faculty_ids},
        },
        {'_id': 0, 'faculty_id': 1, 'section_id': 1, 'term_id': 1},
    )
    assignments = [a async for a in cur]
    if not assignments:
        return result

    section_ids = sorted({str(a.get('section_id') or '').strip() for a in assignments if str(a.get('section_id') or '').strip()})
    if not section_ids:
        return result

    valid_section_ids: set[str] = set()
    for a in assignments:
        sid = str(a.get('section_id') or '').strip()
        if sid and str(a.get('term_id') or '').strip() == term_id:
            valid_section_ids.add(sid)

    try:
        cur_sub = db[COL_SECTIONS_SUBMITTED].find(
            {'term_id': term_id, 'section_id': {'$in': section_ids}},
            {'_id': 0, 'section_id': 1},
        )
        async for sec in cur_sub:
            sid = str(sec.get('section_id') or '').strip()
            if sid:
                valid_section_ids.add(sid)
    except Exception:
        pass

    try:
        cur_sec = db[COL_SECTIONS].find(
            {'term_id': term_id, 'section_id': {'$in': section_ids}},
            {'_id': 0, 'section_id': 1},
        )
        async for sec in cur_sec:
            sid = str(sec.get('section_id') or '').strip()
            if sid:
                valid_section_ids.add(sid)
    except Exception:
        pass

    try:
        cur_sched = db[COL_SCHED].find(
            {'term_id': term_id, 'section_id': {'$in': section_ids}},
            {'_id': 0, 'section_id': 1},
        )
        async for sched in cur_sched:
            sid = str(sched.get('section_id') or '').strip()
            if sid:
                valid_section_ids.add(sid)
    except Exception:
        pass

    assignments = [a for a in assignments if str(a.get('section_id') or '').strip() in valid_section_ids]
    if not assignments:
        return result

    scoped_section_ids = sorted({str(a.get('section_id') or '').strip() for a in assignments if str(a.get('section_id') or '').strip()})
    sched_cur = db[COL_SCHED].find(
        {'section_id': {'$in': scoped_section_ids}},
        {'_id': 0, 'section_id': 1, 'day': 1, 'day_of_week': 1, 'start_time': 1, 'end_time': 1, 'begin': 1, 'end': 1},
    )
    schedules_by_section: Dict[str, List[Dict[str, Any]]] = {}
    async for sched in sched_cur:
        sid = str(sched.get('section_id') or '').strip()
        if sid:
            schedules_by_section.setdefault(sid, []).append(sched)

    seen_slots: Dict[str, set[tuple[str, str, str, str]]] = {fid: set() for fid in faculty_ids}

    for asg in assignments:
        fid = str(asg.get('faculty_id') or '').strip()
        sid = str(asg.get('section_id') or '').strip()
        if not fid or not sid:
            continue
        for sched in schedules_by_section.get(sid, []):
            day = _normalize_day_short(sched.get('day') or sched.get('day_of_week'))
            begin = str(sched.get('start_time') or sched.get('begin') or '').strip()
            end = str(sched.get('end_time') or sched.get('end') or '').strip()
            if begin and not end:
                end = END_BY_BEGIN.get(begin, end)
            if not day or not begin or not end:
                continue
            key = (sid, day, begin, end)
            if key in seen_slots.setdefault(fid, set()):
                continue
            seen_slots[fid].add(key)
            result.setdefault(fid, []).append({
                'section_id': sid,
                'day': day,
                'begin': begin,
                'end': end,
            })

    # Also include accepted Faculty Service schedules directly. This keeps the chair
    # dropdown availability aligned with backend validation even if OM reflection
    # is delayed or a previous response has not yet been mirrored into assignments.
    try:
        fs_cur = db.faculty_service.find(
            {
                'status': 'responded',
                'faculty.faculty_id': {'$in': faculty_ids},
                'section_id': {'$in': list(valid_section_ids)},
            },
            {
                '_id': 0,
                'section_id': 1,
                'faculty': 1,
                'day1': 1,
                'begin1': 1,
                'end1': 1,
                'day2': 1,
                'begin2': 1,
                'end2': 1,
            },
        )
        async for fs in fs_cur:
            fid = str(((fs.get('faculty') or {}).get('faculty_id')) or '').strip()
            sid = str(fs.get('section_id') or '').strip()
            if not fid or not sid:
                continue
            for suffix in ('1', '2'):
                day = _normalize_day_short(fs.get(f'day{suffix}'))
                begin = str(fs.get(f'begin{suffix}') or '').strip()
                end = str(fs.get(f'end{suffix}') or '').strip()
                if begin and not end:
                    end = END_BY_BEGIN.get(begin, end)
                if not day or not begin or not end:
                    continue
                key = (sid, day, begin, end)
                if key in seen_slots.setdefault(fid, set()):
                    continue
                seen_slots[fid].add(key)
                result.setdefault(fid, []).append({
                    'section_id': sid,
                    'day': day,
                    'begin': begin,
                    'end': end,
                })
    except Exception:
        pass

    return result


async def _find_faculty_schedule_conflicts(
    *,
    row: Dict[str, Any],
    faculty_id: str,
    payload: Dict[str, Any],
) -> List[str]:
    active_term = await _active_term()
    term_id = str((active_term or {}).get('term_id') or '').strip()
    fid = str(faculty_id or '').strip()
    if not term_id or not fid:
        return []

    meetings = _meeting_slots_from_payload(payload)
    if not meetings:
        return []

    exclude_section_ids = set(await _target_section_ids_for_faculty_service_row(row))
    busy_map = await _faculty_busy_slots(term_id, [fid], db)
    conflicts: List[str] = []

    for meeting in meetings:
        for busy in busy_map.get(fid, []):
            sid = str(busy.get('section_id') or '').strip()
            if sid and sid in exclude_section_ids:
                continue
            if _normalize_day_short(busy.get('day')) != meeting['day']:
                continue
            b = _time_to_minutes(busy.get('begin'))
            e = _time_to_minutes(busy.get('end'))
            if b is None or e is None or e <= b:
                continue
            if _ranges_overlap(meeting['begin_minutes'], meeting['end_minutes'], b, e):
                label = f"{meeting['day']} {meeting['begin']}-{meeting['end']}"
                if label not in conflicts:
                    conflicts.append(label)
    return conflicts


async def _active_faculty_service_section_ids(*, term_id: str, section_ids: Optional[List[str]] = None) -> set[str]:
    """Return section_ids that already have a non-terminal Faculty Service request.

    A section should not be requestable again while there is already an existing
    request for that same section waiting to be resolved/assigned.
    """

    q: Dict[str, Any] = {
        "status": {"$in": ["sent", "responded"]},
        "section_id": {"$nin": [None, ""]},
    }
    if section_ids is not None:
        scoped = [str(s or '').strip() for s in section_ids if str(s or '').strip()]
        if not scoped:
            return set()
        q["section_id"] = {"$in": scoped}

    out: set[str] = set()
    cur = db.faculty_service.find(q, {"_id": 0, "section_id": 1})
    async for doc in cur:
        sid = str(doc.get("section_id") or "").strip()
        if sid:
            out.add(sid)
    return out

# --------------------------- OPTIONS ---------------------------

@router.get("/options")
async def fs_options(
    q: Optional[str] = Query(None, description="Search for course code/title"),
    toDepartment: Optional[str] = Query(None, description="Populate faculty options for this TO dept"),
    requesterDepartment: Optional[str] = Query(None, description="Filter courses to this requester's department"),
    courseCode: Optional[str] = Query(None, description="When provided, also return sections for this course in the active term")
):
    # Courses shown in the Create Request table MUST reflect what's in the
    # OM Load Assignment table (i.e., submitted sections for the active/planning term).
    #
    # Strategy:
    # - For the requester's department, read distinct (course_code, title, units)
    #   from `sections_submitted` + `courses` for the active term.
    # - Optional `q` filters by code/title.
    # - Fall back to the legacy `courses` collection lookup when we can't resolve
    #   the department or active term.

    active_term = await _active_term()
    active_term_id = (active_term or {}).get("term_id")

    courses: List[Dict[str, Any]] = []

    dept_id: Optional[str] = None
    if requesterDepartment:
        d = await _find_department(requesterDepartment)
        if d and d.get("department_id"):
            dept_id = d["department_id"]

    # Only compute course options when the client is actually asking for them.
    # (Some callers use /options solely to populate faculty dropdowns.)
    wants_courses = bool(requesterDepartment or q)

    if wants_courses and dept_id and active_term_id:
        # Read from OM Load Assignment source (sections_submitted).
        #
        # IMPORTANT:
        # Faculty Service (CHAIR) must only show course/sections that are BOTH:
        #   - unassigned in OM Load Assignment, and
        #   - not already covered by an existing active Faculty Service request.
        #
        # We treat a section as unavailable when there exists either:
        #   - a non-archived faculty_assignments row with a non-empty faculty_id, or
        #   - a faculty_service row for the same section that is still active
        #     (status in {sent, responded}).
        pipe: List[Dict[str, Any]] = [
            {
                "$match": {
                    "term_id": active_term_id,
                    "submitted_for_scheduling": True,
                }
            },
            {
                "$lookup": {
                    "from": COL_ASSIGN,
                    "let": {"sid": "$section_id"},
                    "pipeline": [
                        {
                            "$match": {
                                "$expr": {
                                    "$and": [
                                        {"$eq": ["$section_id", "$$sid"]},
                                        {"$ne": ["$is_archived", True]},
                                        {"$ne": ["$faculty_id", None]},
                                        {"$ne": ["$faculty_id", ""]},
                                    ]
                                }
                            }
                        },
                        {"$project": {"_id": 1}},
                        {"$limit": 1},
                    ],
                    "as": "_assigned",
                }
            },
            {
                "$lookup": {
                    "from": "faculty_service",
                    "let": {"sid": "$section_id"},
                    "pipeline": [
                        {
                            "$match": {
                                "$expr": {"$eq": ["$section_id", "$$sid"]},
                                "status": {"$in": ["sent", "responded"]},
                            }
                        },
                        {"$project": {"_id": 1}},
                        {"$limit": 1},
                    ],
                    "as": "_active_fs",
                }
            },
            {"$match": {"_assigned": {"$size": 0}, "_active_fs": {"$size": 0}}},
            {
                "$lookup": {
                    "from": "courses",
                    "localField": "course_id",
                    "foreignField": "course_id",
                    "as": "course",
                }
            },
            {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": False}},
            {"$match": {"course.department_id": dept_id}},
            {
                "$addFields": {
                    "course_code_display": {
                        "$cond": [
                            {"$isArray": "$course.course_code"},
                            {"$ifNull": [{"$arrayElemAt": ["$course.course_code", 0]}, ""]},
                            {"$ifNull": ["$course.course_code", ""]},
                        ]
                    }
                }
            },
        ]

        if q:
            pipe.append(
                {
                    "$match": {
                        "$or": [
                            {"course_code_display": {"$regex": q, "$options": "i"}},
                            {"course.course_title": {"$regex": q, "$options": "i"}},
                        ]
                    }
                }
            )


        pipe += [
            {
                "$group": {
                    "_id": {
                        "code": "$course_code_display",
                        "title": "$course.course_title",
                        "units": "$course.units",
                    }
                }
            },
            {
                "$project": {
                    "_id": 0,
                    "code": "$_id.code",
                    "title": "$_id.title",
                    "units": "$_id.units",
                }
            },
            {"$sort": {"code": 1, "title": 1}},
            {"$limit": 500},
        ]

        async for r in db["sections_submitted"].aggregate(pipe):
            courses.append(
                {
                    "code": _normalize_code(r.get("code")),
                    "title": (r.get("title") or "").strip(),
                    "units": r.get("units"),
                }
            )
    elif wants_courses:
        # Legacy fallback (keeps existing behavior when OM context isn't available)
        course_filter: Dict[str, Any] = {}
        if dept_id:
            course_filter["department_id"] = dept_id
        if q:
            course_filter["$or"] = [
                {"course_code": {"$regex": q, "$options": "i"}},
                {"course_title": {"$regex": q, "$options": "i"}},
            ]
        cur = db.courses.find(
            course_filter or {},
            {"_id": 0, "course_code": 1, "course_title": 1, "units": 1},
        ).limit(500)
        async for c in cur:
            courses.append(
                {
                    "code": _normalize_code(c.get("course_code")),
                    "title": (c.get("course_title") or "").strip(),
                    "units": c.get("units"),
                }
            )
    else:
        # Keep the endpoint lightweight for callers that only need departments/faculty.
        courses = []

    # Sections for a specific course (used by Create Request so the request targets a single OM row)
    sections: List[Dict[str, Any]] = []
    if courseCode and dept_id and active_term_id:
        code = _normalize_code(courseCode)
        # Locate the course_id (prefer scoping to the requester's dept, fallback otherwise)
        course_doc = await db.courses.find_one(
            {
                "$and": [
                    {"$or": [{"course_code": code}, {"course_code": [code]}]},
                    {"department_id": dept_id},
                ]
            },
            {"_id": 0, "course_id": 1},
        )
        if not course_doc:
            course_doc = await _course_by_code(code)

        course_id = (course_doc or {}).get("course_id")
        if course_id:
            cur = db["sections_submitted"].find(
                {
                    "term_id": active_term_id,
                    "submitted_for_scheduling": True,
                    "course_id": course_id,
                },
                {"_id": 0, "section_id": 1, "section_code": 1},
            ).sort([("section_code", 1)])

            # Collect section ids first so we can batch-check assignment state.
            raw: List[Dict[str, str]] = []
            seen: set[str] = set()
            async for s in cur:
                sid = str(s.get("section_id") or "").strip()
                sc = str(s.get("section_code") or "").strip()
                if not sid or sid in seen:
                    continue
                seen.add(sid)
                raw.append({"section_id": sid, "section_code": sc})

            if raw:
                sids = [r["section_id"] for r in raw]
                # Assigned sections: any non-archived assignment with a real faculty_id.
                asg_cur = db[COL_ASSIGN].find(
                    {
                        "section_id": {"$in": sids},
                        "is_archived": {"$ne": True},
                        "faculty_id": {"$nin": [None, ""]},
                    },
                    {"_id": 0, "section_id": 1},
                )
                assigned: set[str] = set()
                async for a in asg_cur:
                    sid = str(a.get("section_id") or "").strip()
                    if sid:
                        assigned.add(sid)

                active_requested = await _active_faculty_service_section_ids(term_id=active_term_id, section_ids=sids)

                for r in raw:
                    if r["section_id"] in assigned or r["section_id"] in active_requested:
                        continue
                    sections.append(r)

    faculty_opts = await _faculty_dropdown(toDepartment) if toDepartment else []
    faculty_availability: Dict[str, List[Dict[str, str]]] = {}
    if faculty_opts and active_term_id:
        faculty_availability = await _faculty_busy_slots(
            active_term_id,
            [str(f.get("faculty_id") or "").strip() for f in faculty_opts],
            db,
        )

    return {
        "ok": True,
        "courses": courses,
        "sections": sections,
        "departments": await _list_department_names(),
        "timeBegins": BEGIN,
        "days": DAYS,
        "facultyOptions": faculty_opts,
        "facultyAvailability": faculty_availability,
        "activeTerm": active_term,  # <--- added
    }


# ---------------------------- LIST ----------------------------

@router.get("/list")
async def fs_list(
    status: Optional[str] = Query(None),
    dept: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    box: Optional[str] = Query(None, description='"sent" or "received"'),
):
    q: Dict[str, Any] = {}
    if status:
        q["status"] = status
    if dept:
        if box == "sent":
            q["from_department"] = dept
        elif box == "received":
            q["to_department"] = dept
        else:
            q["$or"] = [{"from_department": dept}, {"to_department": dept}]
    if search:
        q["$or"] = q.get("$or", []) + [
            {"course_code": {"$regex": search, "$options": "i"}},
            {"course_title": {"$regex": search, "$options": "i"}},
        ]

    cur = db.faculty_service.find(q, {"_id": 0}).sort([("created_at", -1)])
    rows = [doc async for doc in cur]

    # DB restore/clean guard:
    # After an admin DB restore/clean, `sections_submitted` is usually cleared and then
    # re-imported. However, the `faculty_service` collection may *not* be cleared, causing
    # previously-approved/old requests to keep showing on the CHAIR page.
    #
    # We proactively remove stale faculty_service rows using a *global* snapshot timestamp:
    #   - Let `snapshot_ts` be the most recent timestamp found in sections_submitted.
    #   - Any faculty_service request whose created/updated timestamp is *older* than
    #     snapshot_ts is considered pre-restore (or pre-reimport) and will be deleted.
    #
    # This matches the "after restore everything is clean" behavior you expect, even when
    # section_ids happen to be reused.
    try:
        # 1) Determine the newest "section snapshot" timestamp (best-effort).
        snap_doc = await db[COL_SECTIONS_SUBMITTED].find_one(
            {},
            {
                "_id": 0,
                "snapshot_at": 1,
                "imported_at": 1,
                "submitted_at": 1,
                "created_at": 1,
                "createdAt": 1,
                "updated_at": 1,
                "updatedAt": 1,
            },
            sort=[
                ("snapshot_at", -1),
                ("imported_at", -1),
                ("submitted_at", -1),
                ("updated_at", -1),
                ("created_at", -1),
            ],
        )
        # If there are *no* submitted sections at all, we are likely in a freshly
        # restored/cleaned DB state. In that case, clear any existing faculty_service
        # requests that may have survived the restore.
        if not snap_doc:
            fs_ids = [str(r.get("fs_id") or "").strip() for r in rows if str(r.get("fs_id") or "").strip()]
            if fs_ids:
                await db.faculty_service.delete_many({"fs_id": {"$in": fs_ids}})
            return {"ok": True, "rows": []}

        snapshot_ts = _section_ts(snap_doc)

        section_ids = [str(r.get("section_id") or "").strip() for r in rows]
        section_ids = [sid for sid in section_ids if sid]

        sec_map: Dict[str, Dict[str, Any]] = {}
        if section_ids:
            s_cur = db[COL_SECTIONS_SUBMITTED].find(
                {"section_id": {"$in": section_ids}},
                {"_id": 0, "section_id": 1, "imported_at": 1, "created_at": 1, "createdAt": 1, "updated_at": 1, "updatedAt": 1},
            )
            async for s in s_cur:
                sid = str(s.get("section_id") or "").strip()
                if sid:
                    sec_map[sid] = s

        stale_ids: List[str] = []
        kept: List[Dict[str, Any]] = []

        for r in rows:
            sid = str(r.get("section_id") or "").strip()
            fs_id = str(r.get("fs_id") or "").strip()
            if not sid or not fs_id:
                # malformed record; keep it visible rather than risking data loss
                kept.append(r)
                continue

            # 2) Global restore/re-import cleanup: if the request predates the latest
            #    section snapshot, it is always stale.
            req_ts = _doc_ts(r)
            if snapshot_ts and req_ts and req_ts < snapshot_ts:
                stale_ids.append(fs_id)
                continue

            sec_doc = sec_map.get(sid)
            if not sec_doc:
                stale_ids.append(fs_id)
                continue

            sec_ts = _section_ts(sec_doc)
            if req_ts and sec_ts and req_ts < sec_ts:
                stale_ids.append(fs_id)
                continue

            kept.append(r)

        if stale_ids:
            await db.faculty_service.delete_many({"fs_id": {"$in": stale_ids}})
        rows = kept
    except Exception:
        # Never block listing if the cleanup guard fails.
        pass

    return {"ok": True, "rows": rows}

# --------------------------- CREATE ---------------------------

@router.post("/create")
async def fs_create(payload: Dict[str, Any] = Body(...)):
    course_code = _normalize_code(payload.get("course_code"))
    section_id = str(payload.get("section_id") or "").strip()
    section_code = str(payload.get("section") or payload.get("section_code") or "").strip()
    units = payload.get("units", None)
    to_department = payload.get("to_department")
    course_title = (payload.get("course_title") or "").strip()
    from_department = (payload.get("from_department") or "").strip()

    # Canonicalize departments (accept name/code/id, store dept_name)
    to_department = await _canon_dept_name(to_department)
    from_department = await _canon_dept_name(from_department)

    if not to_department:
        raise HTTPException(status_code=400, detail="to_department is required.")
    if not from_department:
        raise HTTPException(status_code=400, detail="from_department is required.")

    to_known = await _find_department(to_department)
    from_known = await _find_department(from_department)

    def _in_default(x: str) -> bool:
        xn = " ".join((x or "").lower().split())
        return any(" ".join(d.lower().split()) == xn for d in DEFAULT_DEPTS)

    if not (to_known or _in_default(to_department)):
        raise HTTPException(status_code=400, detail="to_department must be a valid department.")
    if not (from_known or _in_default(from_department)):
        raise HTTPException(status_code=400, detail="from_department must be a valid department.")

    if to_department == from_department:
        raise HTTPException(status_code=400, detail="to_department cannot be the same as from_department.")
    if not course_code:
        raise HTTPException(status_code=400, detail="course_code is required.")
    if not section_id:
        raise HTTPException(status_code=400, detail="section_id is required.")

    existing_active = await db.faculty_service.find_one(
        {
            "section_id": section_id,
            "status": {"$in": ["sent", "responded"]},
        },
        {"_id": 0, "fs_id": 1},
    )
    if existing_active:
        raise HTTPException(status_code=400, detail="A request already exists for this section.")

    # Validate section belongs to the selected course in the active/planning term when possible.
    try:
        active_term = await _active_term()
        term_id = (active_term or {}).get("term_id")
        from_dept_id = (from_known or {}).get("department_id") if from_known else None

        if term_id:
            # Resolve course_id for the requested course (prefer scoping to requesting dept if possible)
            course_doc = await db.courses.find_one(
                {
                    "$and": [
                        {"$or": [{"course_code": course_code}, {"course_code": [course_code]}]},
                        *([{"department_id": from_dept_id}] if from_dept_id else []),
                    ]
                },
                {"_id": 0, "course_id": 1},
            )
            if not course_doc:
                course_doc = await _course_by_code(course_code)

            course_id = (course_doc or {}).get("course_id")
            if course_id:
                sec = await db[COL_SECTIONS_SUBMITTED].find_one(
                    {
                        "term_id": term_id,
                        "submitted_for_scheduling": True,
                        "course_id": course_id,
                        "section_id": section_id,
                    },
                    {"_id": 0, "section_id": 1, "section_code": 1},
                )
                if not sec:
                    raise HTTPException(status_code=400, detail="Selected section is not valid for this course in the active term.")
                if not section_code:
                    section_code = str(sec.get("section_code") or "").strip()
    except HTTPException:
        raise
    except Exception:
        # Do not block creation if OM context is unavailable; section_id will still be saved.
        pass

    # resolve title/units from catalog if missing
    if not course_title or units is None:
        c = await _course_by_code(course_code)
        if c:
            if not course_title:
                course_title = c.get("course_title") or ""
            if units is None:
                units = c.get("units", None)

    # from_department is now required from payload and validated above

    fs_id = f"FS{uuid4().hex[:10].upper()}"
    now = _now_iso()
    doc = {
        "fs_id": fs_id,
        "status": "sent",  # created via UI "Send" button
        "created_at": now,
        "updated_at": now,
        "from_department": from_department,
        "to_department": to_department,
        "course_code": course_code,
        "section_id": section_id,
        "section": section_code,
        "course_title": course_title,
        "units": units,
        "faculty": {},
        "day1": "",
        "begin1": "",
        "end1": "",
        "day2": "",
        "begin2": "",
        "end2": "",
        "remarks": "",
            }
    await db.faculty_service.insert_one(doc)
    
    # FIX: Remove the non-serializable ObjectId before returning
    doc.pop("_id", None) 
    
    return {"ok": True, "row": doc}
# ----------------------------- SEND -----------------------------
# Robust + idempotent: mark as sent and (optionally) log email. Lack of recipient mapping will NOT error.

@router.post("/send/{fs_id}")
async def fs_send(
    fs_id: str,
    userId: str | None = Query(None, description="(Optional) Acting user id; used as Gmail sender when available"),
):
    row = await db.faculty_service.find_one({"fs_id": fs_id})
    if not row:
        raise HTTPException(status_code=404, detail="Not found.")

    await db.faculty_service.update_one(
        {"fs_id": fs_id}, {"$set": {"status": "sent", "updated_at": _now_iso()}}
    )

    to_dept = row.get("to_department")

    # In-app notification to receiving department chair user(s)
    try:
        recipients = await _chair_user_ids_for_dept(to_dept or "")
        for uid in recipients:
            await create_notification(
                user_id=uid,
                title="Faculty Service: New request received",
                details=f"{row.get('from_department','')} sent a request for {row.get('course_code','')} – {row.get('course_title','')}.",
                meta={"route": "/chair/faculty-service", "fs_id": fs_id, "kind": "faculty_service_received"},
                send_email=True,
                email_from_user_id=(userId or None),
            )
    except Exception:
        # notifications should not block the request flow
        pass

    # Optional email log stub: pick the primary chair contact (if resolvable)
    try:
        contacts = await _chair_contacts_for_dept(to_dept or "")
        primary = next((c for c in contacts if c.get("email")), None)
        if primary:
            name = primary.get("full_name") or ""
            email = primary.get("email") or ""
            subj = f"Faculty Service Request: {row.get('course_code','')} - {row.get('course_title','')}"
            body = (
                f"Requesting Dept: {row.get('from_department')}\n"
                f"Requested Dept: {to_dept}\n"
                f"Course: {row.get('course_code')} - {row.get('course_title')}\n"
                f"Units: {row.get('units')}\n"
                f"Request ID: {fs_id}\n"
                f"Open in app: /chair/faculty-service?request={fs_id}\n"
            )
            await db.email_logs.insert_one({
                "email_id": f"EM{uuid4().hex[:8].upper()}",
                "to_name": name,
                "to_email": email,
                "subject": subj,
                "body": body,
                "created_at": _now_iso(),
                "type": "faculty_service_send",
                "fs_id": fs_id,
            })
    except Exception:
        pass

    doc = await db.faculty_service.find_one({"fs_id": fs_id}, {"_id": 0})
    return {"ok": True, "row": doc}

# --------------------------- RESPOND ---------------------------

@router.post("/respond/{fs_id}")
async def fs_respond(
    fs_id: str,
    payload: Dict[str, Any] = Body(...),
    userId: str | None = Query(None, description="(Optional) Acting user id; used as Gmail sender when available"),
):
    row = await db.faculty_service.find_one({"fs_id": fs_id})
    if not row:
        raise HTTPException(status_code=404, detail="Not found.")

    faculty = payload.get("faculty") or {}
    day1 = payload.get("day1", "")
    begin1 = payload.get("begin1", "")
    end1 = END_BY_BEGIN.get(begin1, payload.get("end1", ""))
    day2 = payload.get("day2", "")
    begin2 = payload.get("begin2", "")
    end2 = END_BY_BEGIN.get(begin2, payload.get("end2", ""))
    remarks = payload.get("remarks", "")

    fac_out = {
        "faculty_id": faculty.get("faculty_id"),
        "first_name": faculty.get("first_name"),
        "last_name": faculty.get("last_name"),
        "email": faculty.get("email"),
    }
    if fac_out["faculty_id"] and (not fac_out["first_name"] or not fac_out["last_name"] or not fac_out["email"]):
        prof = await db.faculty_profiles.find_one(
            {"faculty_id": fac_out["faculty_id"]}, {"_id": 0, "first_name": 1, "last_name": 1, "user_id": 1}
        )
        if prof:
            fac_out["first_name"] = fac_out["first_name"] or prof.get("first_name")
            fac_out["last_name"] = fac_out["last_name"] or prof.get("last_name")
            user = await db.users.find_one({"user_id": prof.get("user_id")}, {"_id": 0, "email": 1})
            fac_out["email"] = fac_out["email"] or (user or {}).get("email")

    conflict_labels = await _find_faculty_schedule_conflicts(
        row=row,
        faculty_id=str(fac_out.get("faculty_id") or "").strip(),
        payload={
            "day1": day1, "begin1": begin1, "end1": end1,
            "day2": day2, "begin2": begin2, "end2": end2,
        },
    )
    if conflict_labels:
        raise HTTPException(
            status_code=400,
            detail=(
                "Selected faculty is unavailable for: " + ", ".join(conflict_labels)
            ),
        )

    update = {
        "faculty": fac_out,
        "day1": day1, "begin1": begin1, "end1": end1,
        "day2": day2, "begin2": begin2, "end2": end2,
        "remarks": remarks,
        "status": "responded",
        "updated_at": _now_iso(),
    }
    await db.faculty_service.update_one({"fs_id": fs_id}, {"$set": update})

    # Mirror the accepted faculty service details back into OM Load Assignment
    # sources so the requesting department sees the assigned faculty/schedule.
    reflected_to_om = False
    try:
        await _reflect_faculty_service_to_om(row, update)
        reflected_to_om = True
    except Exception:
        # Best-effort only; do not block the faculty service flow.
        reflected_to_om = False

    # In-app notification back to the requesting department chair user(s)
    try:
        recipients = await _chair_user_ids_for_dept(row.get('from_department') or "")
        for uid in recipients:
            await create_notification(
                user_id=uid,
                title="Faculty Service: Request Accepted",
                details=f"{row.get('to_department','')} accepted {row.get('course_code','')} – {row.get('course_title','')}.",
                meta={"route": "/chair/faculty-service", "fs_id": fs_id, "kind": "faculty_service_responded"},
                send_email=True,
                email_from_user_id=(userId or payload.get("user_id") or payload.get("userId") or None),
            )
    except Exception:
        pass

    # ALSO notify OM(s) for the requesting department since the accepted response is synced
    # into OM Load Assignment.
    try:
        om_uids = await _om_user_ids_for_dept(row.get("from_department") or "")
        if om_uids:
            fac_name = " ".join([
                str((fac_out or {}).get("first_name") or "").strip(),
                str((fac_out or {}).get("last_name") or "").strip(),
            ]).strip()
            fac_name = fac_name or (str((fac_out or {}).get("faculty_id") or "").strip() or "a faculty")

            details = (
                f"Faculty Service Request accepted for {row.get('course_code','')} – {row.get('course_title','')}. "
                f"Assigned to {fac_name}."
            )
            if not reflected_to_om:
                # In the rare case syncing failed, still inform OM so they can verify.
                details += " (Load Assignment sync may need verification.)"

            for uid in om_uids:
                await create_notification(
                    user_id=uid,
                    title="Faculty Service: Load Assignment updated",
                    details=details,
                    meta={
                        "route": "/om/load-assignment",
                        "fs_id": fs_id,
                        "kind": "faculty_service_synced_to_om",
                        "course_code": row.get("course_code"),
                        "section_id": row.get("section_id"),
                    },
                    send_email=True,
                    email_from_user_id=(userId or payload.get("user_id") or payload.get("userId") or None),
                )
    except Exception:
        # notifications should not block the response flow
        pass

    # Notify the assigned faculty (in-app + Gmail) that they have been serviced
    # to the requesting department.
    try:
        fac_uid: str | None = None
        fac_id = str((fac_out or {}).get("faculty_id") or "").strip()
        if fac_id:
            prof = await db.faculty_profiles.find_one(
                {"faculty_id": fac_id},
                {"_id": 0, "user_id": 1, "first_name": 1, "last_name": 1},
            )
            if prof and prof.get("user_id"):
                fac_uid = str(prof.get("user_id") or "").strip() or None

        if fac_uid:
            dept_name = await _canon_dept_name(row.get("from_department") or "")
            dept_name = dept_name or (row.get("from_department") or "")

            sch_parts: list[str] = []
            if day1 and begin1 and end1:
                sch_parts.append(f"{day1} {begin1}–{end1}")
            elif day1 or begin1 or end1:
                sch_parts.append(f"{day1} {begin1}–{end1}".strip())
            if day2 and begin2 and end2:
                sch_parts.append(f"{day2} {begin2}–{end2}")
            elif day2 or begin2 or end2:
                sch_parts.append(f"{day2} {begin2}–{end2}".strip())
            sch_text = "; ".join([p for p in sch_parts if p.strip()])
            if not sch_text:
                sch_text = "Schedule: TBA"

            details = (
                f"You have been serviced to {dept_name or 'a department'} for "
                f"{row.get('course_code','')} – {row.get('course_title','')}. "
                f"{sch_text}."
            )

            await create_notification(
                user_id=fac_uid,
                title="Faculty Service: Serviced",
                details=details,
                meta={
                    "route": "/faculty/overview",
                    "fs_id": fs_id,
                    "kind": "faculty_service_serviced",
                    "from_department": dept_name,
                    "course_code": row.get("course_code"),
                    "section_id": row.get("section_id"),
                },
                send_email=True,
                email_from_user_id=(userId or payload.get("user_id") or payload.get("userId") or None),
            )
    except Exception:
        # notifications should not block the response flow
        pass

    doc = await db.faculty_service.find_one({"fs_id": fs_id}, {"_id": 0})
    return {"ok": True, "row": doc}

# --------------------------- REJECT ---------------------------

@router.post("/reject/{fs_id}")
async def fs_reject(
    fs_id: str,
    payload: Dict[str, Any] = Body(default={}),
    userId: str | None = Query(None, description="(Optional) Acting user id; used as Gmail sender when available"),
):
    row = await db.faculty_service.find_one({"fs_id": fs_id})
    if not row:
        raise HTTPException(status_code=404, detail="Not found.")

    prev_status = (row.get("status") or "sent").strip()

    remarks = (payload.get("remarks") or "").strip()
    await db.faculty_service.update_one(
        {"fs_id": fs_id},
        {"$set": {"status": "rejected", "remarks": remarks, "updated_at": _now_iso()}}
    )

    # If this was previously Approved/Responded and reflected into OM Load Assignment,
    # undo the reflection so the Load Assignment row reverts to having no assigned faculty.
    if prev_status == "responded":
        await _unreflect_faculty_service_from_om(row)

    # In-app notification back to the requesting department chair user(s)
    try:
        recipients = await _chair_user_ids_for_dept(row.get('from_department') or "")
        for uid in recipients:
            await create_notification(
                user_id=uid,
                title="Faculty Service: Request rejected",
                details=f"{row.get('to_department','')} rejected {row.get('course_code','')} – {row.get('course_title','')}. Remarks: {remarks or '—'}",
                meta={"route": "/chair/faculty-service", "fs_id": fs_id, "kind": "faculty_service_rejected"},
                send_email=True,
                email_from_user_id=(userId or payload.get("user_id") or payload.get("userId") or None),
            )
    except Exception:
        pass
    # optional log stub (requester could be notified if mapped to an email)
    from_dept = row.get("from_department", "")

    # Optional email log stub to the requesting department chair (if resolvable)
    from_dept = row.get("from_department", "")
    to_name, to_email = (from_dept, "")
    try:
        contacts = await _chair_contacts_for_dept(from_dept)
        primary = next((c for c in contacts if c.get("email")), None)
        if primary:
            to_name = primary.get("full_name") or to_name
            to_email = primary.get("email") or to_email
    except Exception:
        pass

    try:
        await db.email_logs.insert_one({
            "email_id": f"EM{uuid4().hex[:8].upper()}",
            "to_name": to_name,
            "to_email": to_email,
            "subject": f"Faculty Service Request Rejected: {row.get('course_code','')}",
            "body": f"Request {fs_id} has been rejected.\nRemarks: {remarks}",
            "created_at": _now_iso(),
            "type": "faculty_service_reject",
            "fs_id": fs_id,
        })
    except Exception:
        pass
    doc = await db.faculty_service.find_one({"fs_id": fs_id}, {"_id": 0})
    return {"ok": True, "row": doc}


# --------------------------- RESTORE (Undo/Redo helper) ---------------------------

@router.post("/restore/{fs_id}")
async def fs_restore(fs_id: str, payload: Dict[str, Any] = Body(default={})):
    """Restore/overwrite a subset of fields on a Faculty Service row.

    This endpoint is intentionally narrow and is used by the UI to support
    Undo/Redo of *committed* actions (e.g., Respond / Reject) by restoring the
    previous row snapshot.

    Allowed fields: status, faculty, day1/begin1/end1, day2/begin2/end2, remarks.
    """

    row = await db.faculty_service.find_one({"fs_id": fs_id})
    if not row:
        raise HTTPException(status_code=404, detail="Not found.")

    prev_status = (row.get("status") or "sent").strip()

    allowed_status = {"sent", "responded", "rejected"}
    status = (payload.get("status") or row.get("status") or "sent").strip()
    if status not in allowed_status:
        raise HTTPException(status_code=400, detail="Invalid status.")

    faculty = payload.get("faculty") if isinstance(payload.get("faculty"), dict) else None
    remarks = payload.get("remarks")

    # schedule fields
    day1 = payload.get("day1")
    begin1 = payload.get("begin1")
    end1 = payload.get("end1")
    day2 = payload.get("day2")
    begin2 = payload.get("begin2")
    end2 = payload.get("end2")

    # Normalize and compute end times if begin is present but end isn't.
    if begin1 is not None and (end1 is None or end1 == ""):
        end1 = END_BY_BEGIN.get(begin1, end1 or "")
    if begin2 is not None and (end2 is None or end2 == ""):
        end2 = END_BY_BEGIN.get(begin2, end2 or "")

    update: Dict[str, Any] = {
        "status": status,
        "updated_at": _now_iso(),
    }

    if faculty is not None:
        update["faculty"] = {
            "faculty_id": faculty.get("faculty_id"),
            "first_name": faculty.get("first_name"),
            "last_name": faculty.get("last_name"),
            "email": faculty.get("email"),
        }

    if day1 is not None:
        update["day1"] = day1
    if begin1 is not None:
        update["begin1"] = begin1
    if end1 is not None:
        update["end1"] = end1
    if day2 is not None:
        update["day2"] = day2
    if begin2 is not None:
        update["begin2"] = begin2
    if end2 is not None:
        update["end2"] = end2
    if remarks is not None:
        update["remarks"] = str(remarks)

    if status == "responded":
        merged_payload = {
            "day1": update.get("day1", row.get("day1")),
            "begin1": update.get("begin1", row.get("begin1")),
            "end1": update.get("end1", row.get("end1")),
            "day2": update.get("day2", row.get("day2")),
            "begin2": update.get("begin2", row.get("begin2")),
            "end2": update.get("end2", row.get("end2")),
        }
        merged_faculty = update.get("faculty") if isinstance(update.get("faculty"), dict) else row.get("faculty")
        conflict_labels = await _find_faculty_schedule_conflicts(
            row=row,
            faculty_id=str((merged_faculty or {}).get("faculty_id") or "").strip(),
            payload=merged_payload,
        )
        if conflict_labels:
            raise HTTPException(
                status_code=400,
                detail=("Selected faculty is unavailable for: " + ", ".join(conflict_labels)),
            )

    await db.faculty_service.update_one({"fs_id": fs_id}, {"$set": update})

    # Keep OM Load Assignment reflection consistent with status transitions
    # - moving away from responded => undo faculty assignment reflection
    # - moving into responded => apply reflection using the restored snapshot
    if prev_status == "responded" and status != "responded":
        await _unreflect_faculty_service_from_om(row)
    elif prev_status != "responded" and status == "responded":
        merged = {**row, **update}
        await _reflect_faculty_service_to_om(merged, merged)
    doc = await db.faculty_service.find_one({"fs_id": fs_id}, {"_id": 0})
    return {"ok": True, "row": doc}
