from __future__ import annotations

from datetime import datetime, timedelta, timezone
from math import ceil
import re
import json
import hashlib
import secrets
from bson import ObjectId
from typing import Any, Dict, List, Optional, Tuple, Literal, Set
from collections import defaultdict

from fastapi import APIRouter, HTTPException, Query, Body
from pymongo.errors import DuplicateKeyError
from ..main import db
from ..Notifications import create_notification

router = APIRouter(prefix="/apo", tags=["apo"])

# ------------ collections ------------
COL_TERMS = "terms"
COL_CURRICULUM = "curriculum"
COL_COURSES = "courses"
COL_DEPARTMENTS = "departments"
COL_PROGRAMS = "programs"
COL_BATCHES = "batches"
COL_SECTIONS = "sections"
COL_SECTIONS_SUBMITTED = "sections_submitted"
COL_SCHEDS = "section_schedules"
COL_ROOMS = "rooms"
COL_USERS = "users"
COL_FAC_PROFILES = "faculty_profiles"
COL_FAC_LOADS = "faculty_loads"
COL_FAC_ASSIGN = "faculty_assignments"
COL_PREEN = "preenlistment_count"
COL_PREEN_STATS = "preenlistment_statistics"
COL_USER_ROLES = "user_roles"
COL_ROLE_ASSIGN = "role_assignments"
COL_OUTBOX = "outbox"
COL_CAMPUSES = "campuses"
COL_OVR_TOKENS = "override_tokens"
COL_OVR_AUDIT = "override_audit"
COL_PLANSTATE = "planning_state"
COL_SPECIAL = "special_class"
COL_APO_OFFERINGS_AUDIT = "apo_offerings_audit"
COL_APO_SUBMISSIONS = "apo_scheduling_submissions"
COL_OM_SUBMIT_WINDOWS = "om_submit_windows"

# Undo/Redo support:
# - When a section is SOFT-deleted we can restore it by flipping status back to active.
# - When a section is HARD-deleted (never submitted yet), we keep a short-lived snapshot here
#   so the UI can restore the exact record (same section_id / section_code) without re-adding.
COL_APO_SECTION_TRASH = "apo_section_trash"
DEFAULT_CAP = 20
def _audit_id() -> str:
    return _id("AUD-")

async def _course_meta(course_id: str, db) -> Dict[str, Any]:
    if not course_id:
        return {}
    return await db[COL_COURSES].find_one(
        {"course_id": course_id},
        {"_id": 0, "course_code": 1, "department_id": 1},
    ) or {}

def _course_code_str(course_doc: Dict[str, Any]) -> str:
    cc = course_doc.get("course_code")
    if isinstance(cc, list):
        return (cc[0] or "").strip()
    return (cc or "").strip()

async def _audit_offering_change(
    *, action: str, user_id: str, term_id: str, campus_id: str,
    section_id: str, section_code: str, course_id: str,
    changes: Optional[Dict[str, Any]], db
):
    c = await _course_meta(course_id, db)
    await db[COL_APO_OFFERINGS_AUDIT].insert_one({
        "audit_id": _audit_id(),
        "action": action,  # "add" | "edit" | "delete"
        "user_id": user_id,
        "term_id": term_id,
        "campus_id": campus_id,
        "department_id": (c.get("department_id") or "").strip(),
        "course_id": course_id,
        "course_code": _course_code_str(c),
        "section_id": section_id,
        "section_code": section_code,
        "changes": changes or {},
        "created_at": now(),
    })

async def _last_submit_at(term_id: str, campus_id: str, db):
    doc = await db[COL_APO_SUBMISSIONS].find_one(
        {"term_id": term_id, "campus_id": campus_id},
        {"_id": 0, "last_submitted_at": 1},
    ) or {}
    return doc.get("last_submitted_at")

def _summarize_audits(audits: List[Dict[str, Any]], max_items: int = 5) -> str:
    if not audits:
        return "No tracked changes."

    added = [a for a in audits if a.get("action") == "add"]
    edited = [a for a in audits if a.get("action") == "edit"]
    deleted = [a for a in audits if a.get("action") == "delete"]

    def fmt(a: Dict[str, Any]) -> str:
        cc = (a.get("course_code") or a.get("course_id") or "").strip()
        sc = (a.get("section_code") or a.get("section_id") or "").strip()
        if a.get("action") == "edit":
            fields = list((a.get("changes") or {}).keys())
            fields_s = ", ".join(fields[:4]) + ("…" if len(fields) > 4 else "")
            return f"Edited {cc} {sc} ({fields_s})" if fields_s else f"Edited {cc} {sc}"
        if a.get("action") == "add":
            return f"Added {cc} {sc}"
        return f"Deleted {cc} {sc}"

    lines = []
    lines.append(f"Changes: +{len(added)} added, {len(edited)} edited, -{len(deleted)} deleted.")
    examples = (added + edited + deleted)[:max_items]
    for e in examples:
        lines.append(f"- {fmt(e)}")

    return "\n".join(lines)

def _reset_submission_fields():
    return {
        "submitted_for_scheduling": False,
        "submitted_at": None,
        "submitted_by": None,
    }

async def _dept_name_by_id(dept_id: str, db) -> str:
    if not dept_id:
        return ""
    d = await db[COL_DEPARTMENTS].find_one(
        {"$or": [{"department_id": dept_id}, {"dept_id": dept_id}, {"id": dept_id}]},
        {"_id": 0, "dept_name": 1, "department_name": 1, "name": 1},
    ) or {}
    return (d.get("dept_name") or d.get("department_name") or d.get("name") or "").strip()


async def _om_and_gs_user_ids_for_department_id(dept_id: str, campus_id: Optional[str], db) -> List[str]:
    """
    Resolve OM + GS Coordinator user_id(s) for a department (best effort).

    APO notifications that are targeted to the Office Manager should ALSO be sent to GS Coordinator.

    Strategy:
      1) Look up role_ids whose role_type matches OM / Office Manager OR GS Coordinator.
      2) For each role_assignment:
           - If scope includes {type:'department', id: dept_id} => include
           - Else if scope includes {type:'campus', id: campus_id} => include
           - Else if scope is missing/empty => include (treat as global)
      3) Deduplicate.
    """
    if not dept_id:
        return []

    role_q = {
        "$or": [
            {"role_type": {"$regex": r"(^OM$|Office Manager)", "$options": "i"}},
            {"role_type": {"$regex": r"GS\s*Coordinator", "$options": "i"}},
        ]
    }
    roles = await db[COL_USER_ROLES].find(role_q, {"_id": 0, "role_id": 1}).to_list(200)
    role_ids = [r.get("role_id") for r in roles if r.get("role_id")]
    if not role_ids:
        return []

    ras = await db[COL_ROLE_ASSIGN].find(
        {"role_id": {"$in": role_ids}},
        {"_id": 0, "user_id": 1, "scope": 1},
    ).to_list(1000)

    recipients: List[str] = []
    for ra in ras:
        uid = (ra.get("user_id") or "").strip()
        if not uid:
            continue

        scope = ra.get("scope")
        if not scope:
            # global assignment
            recipients.append(uid)
            continue

        if isinstance(scope, dict):
            scope = [scope]
        if not isinstance(scope, list):
            scope = []

        matched = False
        for s in scope:
            if not isinstance(s, dict):
                continue
            stype = (s.get("type") or "").strip().lower()
            sid = (s.get("id") or "").strip()
            if stype == "department" and sid == dept_id:
                matched = True
                break
            if campus_id and stype == "campus" and sid == str(campus_id).strip():
                matched = True
                break

        if matched:
            recipients.append(uid)

    # Deduplicate (stable)
    out: List[str] = []
    seen = set()
    for u in recipients:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out



async def _om_and_gs_user_ids_for_campus(campus_id: Optional[str], db) -> List[str]:
    """Resolve OM + GS Coordinator user_id(s) for a campus (best effort).

    Deadline windows are campus-specific (Manila vs Laguna). In many deployments,
    OM/GS accounts are scoped to *departments* (not campus), so we must map
    department -> campus_id via departments.campus_id.

    Supports:
      - role_assignments.scope campus
      - role_assignments.scope department (mapped via departments.campus_id)
      - global role assignments (no scope)
      - fallback users.role + users.campus_id (legacy)
    """

    campus_id = (campus_id or "").strip()

    # 1) Role IDs for OM + GS Coordinator
    role_q = {
        "$or": [
            {"role_type": {"$regex": r"(^OM$|Office Manager)", "$options": "i"}},
            {"role_type": {"$regex": r"GS\s*Coordinator", "$options": "i"}},
        ]
    }
    roles = await db[COL_USER_ROLES].find(role_q, {"_id": 0, "role_id": 1}).to_list(200)
    role_ids = [r.get("role_id") for r in roles if r.get("role_id")]

    # 2) Build department_id -> campus_id map once
    dept_to_campus: Dict[str, str] = {}
    try:
        cur_depts = db[COL_DEPARTMENTS].find({}, {"_id": 0, "department_id": 1, "campus_id": 1})
        async for d in cur_depts:
            did = str(d.get("department_id") or "").strip()
            cid = str(d.get("campus_id") or "").strip()
            if did and cid:
                dept_to_campus[did] = cid
    except Exception:
        dept_to_campus = {}

    # Scope helpers
    def _scope_items(scope_val: Any) -> List[Dict[str, Any]]:
        if not scope_val:
            return []
        if isinstance(scope_val, dict):
            return [scope_val]
        if isinstance(scope_val, list):
            return [x for x in scope_val if isinstance(x, dict)]
        return []

    def _scope_has_campus(scope_val: Any, cid: str) -> bool:
        for s in _scope_items(scope_val):
            stype = str(s.get("type") or s.get("scope_type") or "").strip().lower()
            sid = str(s.get("id") or s.get("scope_id") or s.get("campus_id") or "").strip()
            if sid and cid and sid == cid and (stype in ("campus", "campuses", "") or "campus" in stype):
                return True
        return False

    def _scope_department_ids(scope_val: Any) -> List[str]:
        out: List[str] = []
        for s in _scope_items(scope_val):
            stype = str(s.get("type") or s.get("scope_type") or "").strip().lower()
            if "dept" in stype or stype == "department":
                sid = str(s.get("id") or s.get("scope_id") or s.get("department_id") or "").strip()
                if sid:
                    out.append(sid)
        return out

    recipients: List[str] = []

    # 3) Primary: role_assignments for those role_ids
    if role_ids:
        ras = await db[COL_ROLE_ASSIGN].find(
            {"role_id": {"$in": role_ids}},
            {"_id": 0, "user_id": 1, "scope": 1},
        ).to_list(2000)

        for ra in ras:
            uid = str(ra.get("user_id") or "").strip()
            if not uid:
                continue

            scope = ra.get("scope")
            if not scope:
                # global assignment
                recipients.append(uid)
                continue

            if _scope_has_campus(scope, campus_id):
                recipients.append(uid)
                continue

            # department scoped -> map to campus
            for did in _scope_department_ids(scope):
                if dept_to_campus.get(did) == campus_id:
                    recipients.append(uid)
                    break

    # 4) Fallback: users.role + users.campus_id
    if not recipients:
        try:
            cur_users = db[COL_USERS].find(
                {"role": {"$in": ["OM", "Office Manager", "GS", "GS Coordinator"]}},
                {"_id": 0, "user_id": 1, "campus_id": 1},
            )
            async for u in cur_users:
                uid = str(u.get("user_id") or "").strip()
                if not uid:
                    continue
                if not campus_id:
                    recipients.append(uid)
                    continue
                if str(u.get("campus_id") or "").strip() == campus_id:
                    recipients.append(uid)
        except Exception:
            pass

    # Deduplicate (stable)
    out: List[str] = []
    seen = set()
    for u in recipients:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out

# ---------- helpers for ID generation ----------

async def _next_seq(col_name: str, id_field: str, prefix: str, width: int = 4) -> str:
    """Generate the next ID like BATCH0001 / CUR0001 without new collections."""
    last = await db[col_name].find_one(
        {id_field: {"$regex": f"^{prefix}\\d+$"}},
        sort=[(id_field, -1)],
    )
    if not last:
        return f"{prefix}{1:0{width}d}"

    m = re.match(rf"^{prefix}(\d+)$", last[id_field])
    if not m:
        # fallback if format changed
        return f"{prefix}{1:0{width}d}"

    n = int(m.group(1)) + 1
    return f"{prefix}{n:0{width}d}"


async def _next_batch_id() -> str:
    return await _next_seq(COL_BATCHES, "batch_id", "BATCH")


async def _next_curriculum_id() -> str:
    return await _next_seq(COL_CURRICULUM, "curriculum_id", "CUR")

def _norm_course_code(s: str | None) -> str:
    """Normalize course code: trim, uppercase, collapse spaces."""
    if not s:
        return ""
    s = s.strip().upper()
    s = re.sub(r"\s+", " ", s)
    return s

async def _get_planning_term() -> Dict[str, Any]:
    """
    Returns the 'planning' term for offerings/preen planning.

    We follow the same rule used by Pre-Enlistment and OM:
      - base term = the term where is_current == True (or the latest term if none is flagged yet)
      - planning term = the NEXT term in chronological order by (acad_year_start, term_number)
      - if no next term exists, fall back to the base term
    """
    base = await _ensure_current_term()
    if not base or not base.get("term_id"):
        raise HTTPException(status_code=404, detail="No current term found in terms collection.")

    base_year = base.get("acad_year_start")
    base_no = base.get("term_number")

    # If term metadata is missing, fall back to TERM#### + 1 behavior
    if base_year is None or base_no is None:
        base_id = base["term_id"]  # e.g., "TERM0014"
        try:
            prefix = base_id[:4]
            num = int(base_id[4:])
        except (TypeError, ValueError):
            raise HTTPException(status_code=500, detail=f"Invalid term_id format: {base_id}")
        next_id = f"{prefix}{num + 1:04d}"
        planning = await db[COL_TERMS].find_one(
            {"term_id": next_id},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        )
        if not planning:
            planning = await db[COL_TERMS].find_one(
                {"term_id": base_id},
                {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
            ) or {}
        return planning

    cur = db[COL_TERMS].find(
        {
            "$or": [
                {"acad_year_start": {"$gt": base_year}},
                {"acad_year_start": base_year, "term_number": {"$gt": base_no}},
            ]
        },
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    ).sort([("acad_year_start", 1), ("term_number", 1)]).limit(1)

    rows = await cur.to_list(1)
    if rows:
        return rows[0]

    # No future term configured: reuse base so we don't crash
    return {
        "term_id": base.get("term_id"),
        "acad_year_start": base_year,
        "term_number": base_no,
    }



def _parse_iso_dt(s: str) -> Optional[datetime]:
    # Parse ISO8601 string into a timezone-aware UTC datetime.
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).replace('Z', '+00:00'))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


async def _get_om_submit_window(term_id: str, campus_id: str) -> Dict[str, str]:
    # Read the OM submission deadline window for a planning term + campus.
    term_id = (term_id or '').strip()
    campus_id = (campus_id or '').strip()
    if not term_id or not campus_id:
        return {"openISO": "", "deadlineISO": ""}

    w = await db[COL_OM_SUBMIT_WINDOWS].find_one(
        {"term_id": term_id, "campus_id": campus_id},
        {"_id": 0, "openISO": 1, "deadlineISO": 1},
    )
    if not w:
        w = await db[COL_OM_SUBMIT_WINDOWS].find_one(
            {"term_id": term_id, "campus_id": ""},
            {"_id": 0, "openISO": 1, "deadlineISO": 1},
        )

    return {
        "openISO": (w or {}).get("openISO") or "",
        "deadlineISO": (w or {}).get("deadlineISO") or "",
    }
def _parse_course_seq(course_id: str) -> int:
    m = re.match(r"^CRS(\d+)$", course_id or "")
    return int(m.group(1)) if m else 0

async def _next_course_id() -> str:
    last = await db[COL_COURSES].find_one(
        {"course_id": {"$regex": r"^CRS\d+$"}},
        sort=[("course_id", -1)]
    )
    n = _parse_course_seq(last["course_id"]) if last else 0
    for _ in range(50):
        n += 1
        cid = f"CRS{n:04d}"
        exists = await db[COL_COURSES].find_one({"course_id": cid})
        if not exists:
            return cid
    raise HTTPException(status_code=500, detail="Unable to allocate new course_id")
def _parse_seq_with_prefix(prefix: str, value: Optional[str]) -> int:
    m = re.match(rf"^{re.escape(prefix)}(\d+)$", (value or ""))
    return int(m.group(1)) if m else 0

async def _next_seq_id(
    collection: str,
    field: str,
    prefix: str,
    width: int = 4,
    attempts: int = 50,
) -> str:
    """Return next ID like 'SEC0001' / 'FAC0001' for any collection/field."""
    last = await db[collection].find_one(
        {field: {"$regex": rf"^{re.escape(prefix)}\d+$"}},
        sort=[(field, -1)]
    )
    n = _parse_seq_with_prefix(prefix, (last or {}).get(field))
    for _ in range(attempts):
        n += 1
        vid = f"{prefix}{n:0{width}d}"
        exists = await db[collection].find_one({field: vid})
        if not exists:
            return vid
    raise HTTPException(status_code=500, detail=f"Unable to allocate new {field} in {collection}")
# --- ID helpers derived from section_id (SEC####) ---
SEC_NUM_RX = re.compile(r"^SEC(\d+)$")

def _sec_num(section_id: Optional[str]) -> Optional[int]:
    if not section_id:
        return None
    m = SEC_NUM_RX.match(section_id)
    return int(m.group(1)) if m else None

def _sch_id_from_sec(section_id: str, slot: int = 1) -> str:
    n = _sec_num(section_id)
    return f"SCH{n:04d}-{slot:02d}" if n is not None else f"SCH-{section_id}-{slot}"

def _asg_id_from_sec(section_id: str) -> str:
    n = _sec_num(section_id)
    return f"ASG{n:04d}" if n is not None else _id("ASG")

def _clean_mongo_doc(doc: dict) -> dict:
    """Return a JSON-safe copy of a MongoDB doc (ObjectId -> str)."""
    if not doc:
        return {}
    out = {}
    for k, v in doc.items():
        if isinstance(v, ObjectId):
            out[k] = str(v)
        elif isinstance(v, dict):
            out[k] = _clean_mongo_doc(v)
        elif isinstance(v, list):
            out[k] = [str(x) if isinstance(x, ObjectId)
                      else (_clean_mongo_doc(x) if isinstance(x, dict) else x)
                      for x in v]
        else:
            out[k] = v
    # expose course_id and drop _id for frontend
    if "_id" in out and "course_id" not in out:
        out["course_id"] = out["_id"]
    out.pop("_id", None)
    return out

# ---------------- helpers: electives ----------------
async def _fetch_all_specific_electives_async() -> list[dict]:
    """
    Return ALL specific electives from COL_COURSES, even if not in curriculum/preenlistment.
    Match 'Elective Course' robustly; normalize course_code to a string.
    """
    q = {
        "$or": [
            {"type_of_course": {"$regex": r"\belective\s*course\b", "$options": "i"}},
            {
                "$and": [
                    {"type_of_course": {"$regex": r"elective", "$options": "i"}},
                    {"type_of_course": {"$not": {"$regex": r"^\s*elective\s*$", "$options": "i"}}}
                ]
            }
        ]
    }
    proj = {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1, "type_of_course": 1}
    out: list[dict] = []
    async for doc in db[COL_COURSES].find(q, proj):
        code = doc.get("course_code")
        if isinstance(code, list):
            code = code[0] if code else ""
        out.append({
            "course_id": doc.get("course_id") or "",
            "course_code": code or "",
            "course_title": doc.get("course_title") or "",
            "type_of_course": "Elective Course",
        })
    out.sort(key=lambda d: (d.get("course_code") or "").upper())
    return out

# --- ELECTIVE SUPPORT ---
def _ctype(v: Optional[str]) -> str:
    return (v or "").strip().upper()

ELECTIVE_PLACEHOLDER = "ELECTIVE"
ELECTIVE_SPECIFIC = "ELECTIVE COURSE"

# --- COURSE TYPE NORMALIZATION ---
def canonical_course_type(x: Optional[str]) -> str:
    u = _ctype(x)
    if u == "GE" or u == "GE COURSE" or "GENERAL EDUCATION" in u:
        return "GE"
    if u in {"SHS", "SENIOR HIGH", "SENIOR HIGH SCHOOL"}:
        return "SHS"
    if u == "ELECTIVE COURSE":
        return "ELECTIVE COURSE"
    if u == "ELECTIVE":
        return "ELECTIVE"
    if u in {"MAJOR", "FOUNDATION", "COS"}:
        return u
    return u
def _as_list(val):
    if val is None:
        return []
    if isinstance(val, list):
        # normalize and keep non-empty strings
        out = []
        for v in val:
            s = _norm_code(v) if isinstance(v, str) else str(v)
            if s:
                out.append(s)
        return out
    s = _norm_code(val) if isinstance(val, str) else str(val)
    return [s] if s else []

def _int_or_none(v):
    try:
        if v in (None, ""):
            return None
        return int(v)
    except Exception:
        return None

def _build_full_course_document(data: Dict[str, Any], *, course_id: str) -> Dict[str, Any]:
    """
    Return a FULL course doc with all fields present.
    Missing inputs are defaulted to null/""/[] so the record is complete.
    """
    # normalize inputs
    toc_raw = data.get("type_of_course")
    toc_norm = canonical_course_type(toc_raw)
    if toc_norm == "ELECTIVE COURSE":
        type_of_course = "Elective Course"
    elif toc_norm == "ELECTIVE":
        type_of_course = "Elective"
    elif toc_norm in {"GE", "SHS", "MAJOR", "FOUNDATION", "COS"}:
        type_of_course = toc_norm
    else:
        type_of_course = toc_raw or None

    program_level = level_code(data.get("program_level"))  # -> "UGS" / "GSM"
    units_val = data.get("units")
    try:
        units = int(units_val) if units_val not in (None, "") else 0
    except Exception:
        units = 0

    max_enrollee = data.get("max_enrollee", data.get("capacity"))
    me = _int_or_none(max_enrollee)
    if me is None:
        me = DEFAULT_CAP  # keep your existing default unless you want 30 as a global default

    doc = {
        "course_id": course_id,
        "course_code": _as_list(data.get("course_code")),        # ALWAYS an array
        "course_title": (data.get("course_title") or "").strip(),
        "department_id": (data.get("department_id") or "").strip(),
        "program_level": program_level or None,                   # "UGS"/"GSM" or null
        "type_of_course": type_of_course,                         # normalized or null

        # numbers
        "units": units,
        "min_enrollee": _int_or_none(data.get("min_enrollee")),
        "max_enrollee": me,

        # strings
        "room_type": (data.get("room_type") or None),
        "description": (data.get("description") or "").strip(),
        "syllabus": (data.get("syllabus") or "").strip(),

        # arrays
        "course_coordinator": _as_list(data.get("course_coordinator")),
        "prerequisites": _as_list(data.get("prerequisites")),
        "teaching_team": _as_list(data.get("teaching_team")),

        # provenance
        "created_at": now(),
        "updated_at": now(),
    }
    return doc
async def _create_catalog_course(user_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Create a new course in the catalog, used by the Course Offerings UI.

    This is the extracted logic from the old `if action == "catalog.create"` block
    in `post_course_offerings`.
    """
    if not payload:
        raise HTTPException(status_code=400, detail="Missing payload.")

    # Required fields
    course_code = _norm_code((payload.get("course_code") or ""))
    course_title = (payload.get("course_title") or "").strip()
    department_id = (payload.get("department_id") or "").strip()
    program_level_in = payload.get("program_level")  # accepts UG/GS/UGS/GSM or labels
    if not (course_code and course_title and department_id and program_level_in):
        raise HTTPException(
            status_code=422,
            detail="course_code, course_title, department_id, and program_level are required."
        )

    # Validate department exists (optional but safer)
    dep_exists = await db[COL_DEPARTMENTS].find_one({"department_id": department_id}, {"_id": 1})
    if not dep_exists:
        raise HTTPException(status_code=422, detail="department_id not found.")

    # Units (optional)
    units = None
    if "units" in payload and payload.get("units") not in (None, ""):
        try:
            units = float(payload.get("units"))
        except Exception:
            raise HTTPException(status_code=422, detail="units must be a number.")

    # Capacity for planning defaults — we use 'max_enrollee' in this codebase
    max_enrollee = payload.get("max_enrollee", payload.get("capacity"))
    if max_enrollee in (None, ""):
        max_enrollee = DEFAULT_CAP
    try:
        max_enrollee = int(max_enrollee)
        if max_enrollee < 0:
            raise ValueError()
    except Exception:
        raise HTTPException(status_code=422, detail="max_enrollee/capacity must be a non-negative integer.")

    # Optional description
    description = (payload.get("description") or "").strip()

    # Deduplicate by course_code (string or array[0])
    dup = await db[COL_COURSES].find_one(
        {"$or": [{"course_code": course_code}, {"course_code.0": course_code}]},
        {"_id": 1}
    )
    if dup:
        raise HTTPException(status_code=409, detail="Course with the same course_code already exists.")

    # Generate a new course_id (sequential CRS0001... if available)
    try:
        course_id = await _next_course_id()
    except Exception:
        # Fall back to timestamp style if sequence fails
        course_id = _id("CRS")

    # Build a full doc with defaults for missing fields
    doc = _build_full_course_document(
        {
            "course_code": course_code,            # string -> will be stored as ["CODE"]
            "course_title": course_title,
            "department_id": department_id,
            "program_level": program_level_in,     # accept label or code; builder normalizes
            "type_of_course": payload.get("type_of_course"),
            "units": units,
            "max_enrollee": max_enrollee,
            "description": description,
            # optional inputs if your UI ever sends them:
            "min_enrollee": payload.get("min_enrollee"),
            "room_type": payload.get("room_type"),
            "syllabus": payload.get("syllabus"),
            "course_coordinator": payload.get("course_coordinator"),
            "prerequisites": payload.get("prerequisites"),
            "teaching_team": payload.get("teaching_team"),
        },
        course_id=course_id,
    )

    await db[COL_COURSES].insert_one(doc)
    return {"ok": True, "course": _clean_mongo_doc(doc)}

# ------------ utils ------------
def now() -> datetime:
    return datetime.utcnow()

def _ts() -> int:
    return int(datetime.utcnow().timestamp() * 1000)

def _id(prefix: str) -> str:
    return f"{prefix}{_ts()}"
# --- schedule id helpers & ensure functions ---
def _sched_id_for_section(section_id: str, idx: int) -> str:
    """
    Convert 'SEC0613' -> 'SCH0613-01' / 'SCH0613-02'
    Falls back to SCH{section_id}-{idx:02d} if digits can't be parsed.
    """
    m = re.search(r"(\d+)$", section_id or "")
    core = m.group(1) if m else section_id
    return f"SCH{core}-{idx:02d}"

async def _ensure_two_blank_schedules(section_id: str, course_id: Optional[str]) -> None:
    """
    Make sure two schedule docs exist for visualization, with room_type
    taken from courses.room_type. Times/room_id can stay null.
    """
    room_type = None
    if course_id:
        c = await db[COL_COURSES].find_one({"course_id": course_id}, {"_id": 0, "room_type": 1})
        room_type = (c or {}).get("room_type")

    for i in (1, 2):
        sched_id = _sched_id_for_section(section_id, i)
        await db[COL_SCHEDS].update_one(
            {"schedule_id": sched_id},
            {"$setOnInsert": {
                "schedule_id": sched_id,
                "section_id": section_id,
                "day": None, "start_time": None, "end_time": None,
                "room_id": None,
                "room_type": room_type if room_type else None,
                "created_at": now(), "updated_at": now(),
            }},
            upsert=True
        )

async def _ensure_faculty_assignment_stub(section_id: str, term_id: str) -> None:
    """
    Ensure there is at least one non-archived faculty_assignments row
    for the section (even if faculty/user is unknown yet).
    """
    exists = await db[COL_FAC_ASSIGN].find_one(
        {"section_id": section_id, "is_archived": {"$ne": True}},
        {"_id": 1}
    )
    if exists:
        return
    asg_id = await _next_seq_id(COL_FAC_ASSIGN, "assignment_id", "ASG", 4)
    # Note: no user_id needed; faculty_id can remain None for now.
    await db[COL_FAC_ASSIGN].insert_one({
        "assignment_id": asg_id,
        "load_id": None,
        "section_id": section_id,
        "faculty_id": None,
        "term_id": term_id,
        "created_at": now(),
        "updated_at": now(),
        "is_archived": False
    })

def _norm_code(code: Optional[str]) -> str:
    s = (code or "").strip().upper()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"^ID\s*(\d+)$", r"ID \1", s)
    return s

def _code_str(value):
    if isinstance(value, list):
        return value[0] if value else ""
    return value or ""

def ensure_list(x: Any) -> List[Any]:
    if x is None:
        return []
    if isinstance(x, list):
        return x
    return [x]

async def current_term() -> Optional[Dict[str, Any]]:
    return await db[COL_TERMS].find_one({"is_current": True}, {"_id": 0})

async def _ensure_current_term() -> Optional[Dict[str, Any]]:
    t = await current_term()
    if t:
        return t
    sample = await db[COL_PREEN].find_one({}, {"_id": 0, "term_id": 1})
    if sample and sample.get("term_id"):
        await db[COL_TERMS].update_one({"term_id": sample["term_id"]}, {"$set": {"is_current": True}})
        t2 = await current_term()
        if t2:
            return t2
    latest = await db[COL_TERMS].find(
        {}, {"_id": 1, "term_id": 1, "acad_year_start": 1, "term_number": 1}
    ).sort([("acad_year_start", -1), ("term_number", -1)]).limit(1).to_list(1)
    if latest:
        await db[COL_TERMS].update_one({"_id": latest[0]["_id"]}, {"$set": {"is_current": True}})
        return await current_term()
    return None

def _is_ge_course(course: dict) -> bool:
    t = str(course.get("type_of_course") or "").strip().lower()
    return t.startswith("ge") or "general education" in t

def _conflict(violations: list[dict], preview: dict | None = None) -> dict:
    token = secrets.token_hex(16)
    return {
        "conflict": {
            "override_token": token,
            "violations": violations,
            "preview_changes": preview or {},
        }
    }

def _raise_conflict(violations: list[dict], preview: dict | None = None):
    from fastapi import HTTPException
    raise HTTPException(status_code=409, detail=_conflict(violations, preview))

def _coerce_cap(value) -> int | None:
    if value is None:
        return None
    try:
        n = int(value)
        return n if n >= 0 else None
    except Exception:
        return None

async def _sync_section_status_flags(current_term_id: str) -> None:
    """Keep per-term status flags in sync without resurrecting archived rows.

    We use status=active/inactive to indicate whether a section belongs to the planning term.
    Deletions after submission are represented by status=archived; those must remain archived.
    """
    try:
        await db[COL_SECTIONS].create_index(
            [("term_id", 1), ("fulfilled_placeholder_course_id", 1)],
            name="idx_term_fulfilled_placeholder"
        )
    except Exception:
        pass

    # Do not touch archived rows (soft-deleted after submission)
    await db[COL_SECTIONS].update_many(
        {"term_id": current_term_id, "status": {"$nin": ["active", "archived"]}},
        {"$set": {"status": "active", "updated_at": now()}}
    )
    await db[COL_SECTIONS].update_many(
        {"term_id": {"$ne": current_term_id}, "status": {"$nin": ["inactive", "archived"]}},
        {"$set": {"status": "inactive", "updated_at": now()}}
    )

def term_label(t: Optional[Dict[str, Any]]) -> str:
    if not t:
        return ""
    n = t.get("term_number")
    ays = t.get("acad_year_start")
    aye = (ays + 1) if isinstance(ays, int) else None
    return f"Term {n} · AY {ays}-{aye}" if (n and ays and aye) else (t.get("term_id") or "")

async def _refresh_submitted_sections_snapshot(*, term_id: str, campus_id: str, db) -> Dict[str, Any]:
    """Create/refresh the submitted snapshot that OM reads.

    Snapshot is per term_id + campus_id, keyed by (term_id, campus_id, section_id).
    We copy the live section doc (minus _id) so OM sees exactly what was last submitted,
    while assignments/schedules remain live.
    """
    ts = now()
    live_q = {"term_id": term_id, "campus_id": campus_id, "status": {"$ne": "archived"}}
    live_secs = [s async for s in db[COL_SECTIONS].find(live_q, {"_id": 0})]
    live_ids = [s.get("section_id") for s in live_secs if s.get("section_id")]

    # Upsert each live section into snapshot
    upserted = 0
    for s in live_secs:
        sid = (s.get("section_id") or "").strip()
        if not sid:
            continue

        # IMPORTANT:
        # - Do NOT write created_at via $set because it conflicts with $setOnInsert
        # - Do NOT write updated_at in multiple operators
        snap = dict(s)
        snap.pop("created_at", None)
        snap.pop("updated_at", None)

        snap["submitted_for_scheduling"] = True
        snap["snapshot_at"] = ts
        snap["updated_at"] = ts

        await db[COL_SECTIONS_SUBMITTED].update_one(
            {"term_id": term_id, "campus_id": campus_id, "section_id": sid},
            {
                "$set": snap,
                "$setOnInsert": {"created_at": ts},
            },
            upsert=True,
        )
        upserted += 1

    # Remove snapshot rows that no longer exist in live (or are archived)
    snap_q = {"term_id": term_id, "campus_id": campus_id}
    if live_ids:
        removed = await db[COL_SECTIONS_SUBMITTED].delete_many({**snap_q, "section_id": {"$nin": live_ids}})
        removed_n = int(getattr(removed, "deleted_count", 0) or 0)
    else:
        removed = await db[COL_SECTIONS_SUBMITTED].delete_many(snap_q)
        removed_n = int(getattr(removed, "deleted_count", 0) or 0)

    return {"upserted": upserted, "removed": removed_n}


def _strip_room_when_no_time(slot: dict | None) -> dict:
    slot = (slot or {}).copy()
    day = (slot.get("day") or "").strip()
    st  = (slot.get("start_time") or "").strip()
    et  = (slot.get("end_time") or "").strip()
    if not (day and st and et):
        slot.pop("room_id", None)
    return slot

# --- default capacity ---
async def default_capacity_for_course(course_id: str) -> int:
    doc = await db[COL_COURSES].find_one({"course_id": course_id}, {"_id": 0, "max_enrollee": 1})
    try:
        v = doc.get("max_enrollee") if doc else None
        return int(v) if v not in (None, "") else DEFAULT_CAP
    except Exception:
        return DEFAULT_CAP

async def effective_section_capacity(term_id: str, campus_name: str, course_id: str) -> int:
    lvl = await _course_program_level(course_id)
    pref_pat = prefix_pattern_for_level(campus_name, lvl) or ""
    q = {"term_id": term_id, "$or": [{"course_id": course_id}, {"fulfilled_placeholder_course_id": course_id}]}
    if pref_pat:
        q["section_code"] = {"$regex": f"^{pref_pat}", "$options": "i"}

    caps: list[int] = []
    async for s in db[COL_SECTIONS].find(q, {"_id": 0, "enrollment_cap": 1}):
        try:
            v = int(s.get("enrollment_cap") or 0)
            if v > 0:
                caps.append(v)
        except Exception:
            pass

    if caps:
        caps.sort()
        return caps[len(caps)//2]
    return await default_capacity_for_course(course_id)
async def _provision_sched_and_assignment_for_new_section(section_doc: Dict[str, Any]) -> None:
    """
    Ensure every new section has:
      • two placeholder schedules: SCH####-01 and SCH####-02 (room_type from courses.room_type)
      • one placeholder faculty_assignments row (ASG####), NO user_id
    Idempotent; safe if rows already exist.
    """
    try:
        sid = (section_doc or {}).get("section_id")
        cid = (section_doc or {}).get("course_id")
        term_id = (section_doc or {}).get("term_id")
        if not sid:
            return

        # room_type from courses
        course = await db[COL_COURSES].find_one({"course_id": cid}, {"_id": 0, "room_type": 1})
        room_type = (course or {}).get("room_type")

        # Create/ensure two schedules (01 and 02)
        for idx in (1, 2):
            sch_id = _sch_id_from_sec(sid, idx)
            try:
                await db[COL_SCHEDS].update_one(
                    {"section_id": sid, "schedule_id": sch_id},
                    {"$setOnInsert": {
                        "schedule_id": sch_id,
                        "section_id": sid,
                        "day": None,
                        "start_time": None,
                        "end_time": None,
                        "room_id": None,
                        "room_type": room_type,   # <- mirror from courses.room_type
                        "created_at": now(),
                        "updated_at": now(),
                    }},
                    upsert=True
                )
            except Exception:
                pass

        # Ensure exactly one active faculty assignment exists (placeholder if none assigned yet)
        existing_assigned = await db[COL_FAC_ASSIGN].find_one(
            {
                "section_id": sid,
                "is_archived": {"$ne": True},
                "$or": [{"user_id": {"$nin": ["", None]}}, {"faculty_id": {"$nin": ["", None]}}]
            },
            {"_id": 1}
        )
        if not existing_assigned:
            # If there is already an active placeholder, leave it. Otherwise create one.
            existing_active_any = await db[COL_FAC_ASSIGN].find_one(
                {"section_id": sid, "is_archived": {"$ne": True}},
                {"_id": 1}
            )
            if not existing_active_any:
                try:
                    asg_id = _asg_id_from_sec(sid)
                    await db[COL_FAC_ASSIGN].insert_one({
                        "assignment_id": asg_id,
                        "load_id": None,
                        "section_id": sid,
                        "faculty_id": None,
                        "term_id": term_id,
                        "created_at": now(),
                        "is_archived": False,
                    })
                except Exception:
                    pass

    except Exception:
        # Never block section creation because of visualization extras
        pass

# ------------ APO scope / campus ------------
async def apo_scope(user_id: str) -> Tuple[Optional[str], Optional[str]]:
    role = await db[COL_USER_ROLES].find_one(
        {"role_type": {"$regex": "^APO$", "$options": "i"}}, {"_id": 0, "role_id": 1}
    )
    campus_id, college_id = None, None
    if role:
        ra = await db[COL_ROLE_ASSIGN].find_one(
            {"user_id": user_id, "role_id": role["role_id"]}, {"_id": 0, "scope": 1}
        )
        if ra:
            scope = ra.get("scope") or []
            if isinstance(scope, dict):
                scope = [scope]
            for s in scope:
                if isinstance(s, dict) and s.get("type") == "campus":
                    campus_id = s.get("id")
                if isinstance(s, dict) and s.get("type") == "college":
                    college_id = s.get("id")

    if not campus_id:
        u = await db[COL_USERS].find_one({"user_id": user_id}, {"_id": 0, "campus_id": 1})
        campus_id = (u or {}).get("campus_id")

    return (campus_id, college_id)
async def apo_import_curriculum_csv(userId: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Import curriculum rows (List of Courses / flowcharts) from CSV.

    Supports MULTI-TERM import: each CSV row determines its target term via
    (Academic Year start, Term Number). The payload's term_id is kept for backward
    compatibility as a default/fallback only.

    Expected payload from frontend:
    {
        "rows": [
          {
            "Batch": "ID 126",
            "Program Level": "Undergraduate",
            "Program": "BSCS-ST",
            "Term Number": "1",
            "Academic Year": "2027",
            "Campus": "Manila",
            "Course 1": "CCDSALG",
            "Course 2": "CCPROG2"
          },
          ...
        ],
        "term_id": "TERM0015",
        "campus_name": "Manila"
    }

    Behavior:
      - Validates ALL rows first (all-or-nothing). If any error exists, nothing is saved.
      - Upserts curriculum rows by (batch_id, term_id, campus_id).
      - Ensures referenced programs + courses exist.
    """
    rows = payload.get("rows") or []
    default_term_id = payload.get("term_id")
    campus_name = payload.get("campus_name")

    if not isinstance(rows, list) or not default_term_id or not campus_name:
        raise HTTPException(
            status_code=400,
            detail="rows, term_id and campus_name are required for import_curriculum_csv",
        )

    # Validate default term (kept for backward compatibility / fallback)
    default_term = await db[COL_TERMS].find_one({"term_id": default_term_id})
    if not default_term:
        raise HTTPException(status_code=400, detail=f"Unknown term_id {default_term_id!r}")

    # Resolve campus_name -> campus_id
    campus = await db["campuses"].find_one(
        {"$or": [{"campus_name": campus_name}, {"campus_id": campus_name}]}
    )
    if not campus:
        raise HTTPException(status_code=400, detail=f"Unknown campus {campus_name!r}")
    campus_id = campus["campus_id"]

    def _norm(s: Any) -> str:
        return re.sub(r"\s+", "", str(s or "")).strip().lower()

    target_campus_norm = _norm(campus.get("campus_name") or campus_name)
    target_campus_id_norm = _norm(campus_id)

    # ---- Gather unique codes for bulk lookups ----
    program_codes: set[str] = set()
    all_course_codes: set[str] = set()
    term_pairs: set[tuple[int, int]] = set()

    # Detect course columns (Course 1, Course 2, ...)
    def _course_codes_from_row(raw: Dict[str, Any]) -> list[str]:
        out: list[str] = []
        for k, v in (raw or {}).items():
            if isinstance(k, str) and k.strip().lower().startswith("course"):
                s = str(v or "").strip()
                if s:
                    out.append(s)
        return out

    def _parse_term_no(v: Any) -> Optional[int]:
        if v is None:
            return None
        s = str(v).strip()
        if not s:
            return None
        try:
            return int(s)
        except Exception:
            return None

    def _parse_ay_start(v: Any) -> Optional[int]:
        if v is None:
            return None
        s = str(v).strip()
        if not s:
            return None
        m = re.search(r"(\d{4})", s)
        if not m:
            return None
        try:
            return int(m.group(1))
        except Exception:
            return None

    # Pre-scan to collect lookup keys
    for raw in rows:
        if not raw or not isinstance(raw, dict):
            continue
        pc = str(raw.get("Program") or raw.get("Program Code") or raw.get("program") or "").strip()
        if pc:
            program_codes.add(pc)
        for cc in _course_codes_from_row(raw):
            all_course_codes.add(cc)

        tno = _parse_term_no(raw.get("Term Number") or raw.get("TermNumber") or raw.get("term_number"))
        ay = _parse_ay_start(raw.get("Academic Year") or raw.get("AY") or raw.get("acad_year_start"))
        if tno and ay:
            term_pairs.add((ay, tno))

    # Bulk resolve programs
    programs = await db[COL_PROGRAMS].find({"program_code": {"$in": sorted(program_codes)}}).to_list(None)
    program_by_code = {p.get("program_code"): p for p in programs if p and p.get("program_code")}

    # Bulk resolve courses (course_code is an array field)
    course_docs = await db[COL_COURSES].find({"course_code": {"$in": sorted(all_course_codes)}}).to_list(None)
    course_by_code: Dict[str, str] = {}
    for doc in course_docs:
        for code in (doc.get("course_code") or []):
            if code and code not in course_by_code:
                course_by_code[str(code)] = doc["course_id"]

    # Bulk resolve terms by (acad_year_start, term_number)
    term_map: Dict[tuple[int, int], str] = {}
    if term_pairs:
        ay_set = sorted({ay for (ay, _) in term_pairs})
        tn_set = sorted({tn for (_, tn) in term_pairs})
        term_docs = await db[COL_TERMS].find(
            {"acad_year_start": {"$in": ay_set}, "term_number": {"$in": tn_set}},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        ).to_list(None)
        for td in term_docs:
            ay = td.get("acad_year_start")
            tn = td.get("term_number")
            tid = td.get("term_id")
            if ay is not None and tn is not None and tid:
                term_map[(int(ay), int(tn))] = tid

    # ---- Validate ALL rows first (all-or-nothing) ----
    errors: list[str] = []
    normalized_rows: list[Dict[str, Any]] = []

    seen_keys: set[str] = set()

    for i, raw in enumerate(rows):
        row_no = i + 2  # header = row 1
        if not raw or not isinstance(raw, dict):
            continue

        batch_code = str(raw.get("Batch") or raw.get("batch") or "").strip()
        program_code = str(raw.get("Program") or raw.get("Program Code") or raw.get("program") or "").strip()
        campus_cell = str(raw.get("Campus") or raw.get("campus") or "").strip()

        term_no = _parse_term_no(raw.get("Term Number") or raw.get("TermNumber") or raw.get("term_number"))
        ay_start = _parse_ay_start(raw.get("Academic Year") or raw.get("AY") or raw.get("acad_year_start"))

        course_codes = _course_codes_from_row(raw)

        row_errs: list[str] = []
        if not batch_code:
            row_errs.append("Batch is required")
        if not program_code:
            row_errs.append("Program is required")
        if not campus_cell:
            row_errs.append("Campus is required")
        if not term_no:
            row_errs.append("Term Number is required")
        elif term_no < 1 or term_no > 3:
            row_errs.append("Term Number must be 1, 2, or 3")
        if not ay_start:
            row_errs.append("Academic Year must include a 4-digit start year (e.g., 2027)")

        # Campus must match the selected campus (case-insensitive)
        if campus_cell and target_campus_norm and (_norm(campus_cell) not in {target_campus_norm, target_campus_id_norm}):
            row_errs.append(f"Program campus mismatch; you are importing for {campus_name}")

        if not course_codes:
            row_errs.append("At least one course code is required (Course 1, Course 2, ...)")

        # Program exists?
        program = program_by_code.get(program_code) if program_code else None
        if program_code and not program:
            row_errs.append(f"Program {program_code!r} not found")

        # Term exists?
        term_id = default_term_id
        if ay_start and term_no:
            term_id = term_map.get((ay_start, term_no))
            if not term_id:
                row_errs.append(f"No term found for Academic Year {ay_start} Term {term_no}")

        # Courses exist?
        missing_courses = [cc for cc in course_codes if cc not in course_by_code]
        if missing_courses:
            row_errs.append("Unknown course code(s): " + ", ".join(sorted(set(missing_courses))))

        # Duplicate row in file?
        if batch_code and program_code and ay_start and term_no:
            key = f"{batch_code}|{program_code}|{ay_start}|{term_no}".lower()
            if key in seen_keys:
                row_errs.append("Duplicate row for the same Batch + Program + Academic Year + Term Number")
            else:
                seen_keys.add(key)

        if row_errs:
            errors.append(f"Row {row_no}: " + "; ".join(row_errs))
            continue

        program_id = program["program_id"]
        course_ids = [course_by_code[cc] for cc in course_codes if cc in course_by_code]

        normalized_rows.append(
            {
                "batch_code": batch_code,
                "program_code": program_code,
                "program_id": program_id,
                "term_id": term_id,
                "ay_start": ay_start,
                "term_no": term_no,
                "course_ids": course_ids,
            }
        )

    if errors:
        detail = (
            f"Invalid Curriculum CSV file for {str(campus_name).upper()}. Nothing was saved.\n"
            + "\n".join(f"- {e}" for e in errors)
        )
        raise HTTPException(status_code=400, detail=detail)

    if not normalized_rows:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid Curriculum CSV file for {str(campus_name).upper()}. Nothing was saved.\n- No valid rows found.",
        )

    # ---- Apply writes (validated) ----
    created_batches: List[str] = []
    updated_curricula: List[Dict[str, Any]] = []

    # Batch existence map
    batch_key_to_id: Dict[tuple[str, str], str] = {}
    batch_docs = await db[COL_BATCHES].find(
        {"batch_code": {"$in": sorted({r["batch_code"] for r in normalized_rows})}}
    ).to_list(None)
    for b in batch_docs:
        if not b:
            continue
        key = (b.get("batch_code"), b.get("program_id"))
        if key[0] and key[1]:
            batch_key_to_id[(key[0], key[1])] = b["batch_id"]

    # Next batch_id counter
    last_batch = await db[COL_BATCHES].find({"batch_id": {"$regex": r"^BATCH[0-9]+$"}}).sort("batch_id", -1).limit(1).to_list(1)
    next_batch_num = int(last_batch[0]["batch_id"][5:]) if last_batch else 0

    # Determine intake term per (batch_code, program_id) as earliest (ay_start, term_no)
    intake_term_by_batch: Dict[tuple[str, str], str] = {}
    # Compute earliest tuple
    earliest_tuple_by_batch: Dict[tuple[str, str], tuple[int, int, str]] = {}
    for r in normalized_rows:
        key = (r["batch_code"], r["program_id"])
        tup = (int(r["ay_start"]), int(r["term_no"]), r["term_id"])
        prev = earliest_tuple_by_batch.get(key)
        if not prev or (tup[0], tup[1]) < (prev[0], prev[1]):
            earliest_tuple_by_batch[key] = tup

    for key, tup in earliest_tuple_by_batch.items():
        intake_term_by_batch[key] = tup[2]

    # Create missing batches
    for (batch_code, program_id), intake_tid in intake_term_by_batch.items():
        if (batch_code, program_id) in batch_key_to_id:
            continue
        next_batch_num += 1
        batch_id = f"BATCH{next_batch_num:04d}"
        batch_doc = {
            "batch_id": batch_id,
            "batch_code": batch_code,
            "program_id": program_id,
            "intake_term_id": intake_tid,
            "curriculum_id": None,
            "status": "active",
            "created_at": datetime.utcnow(),
            "updated_at": datetime.utcnow(),
        }
        await db[COL_BATCHES].insert_one(batch_doc)
        batch_key_to_id[(batch_code, program_id)] = batch_id
        created_batches.append(batch_id)

    # Next curriculum_id counter
    last_cur = await db[COL_CURRICULUM].find({"curriculum_id": {"$regex": r"^CUR[0-9]+$"}}).sort("curriculum_id", -1).limit(1).to_list(1)
    next_cur_num = int(last_cur[0]["curriculum_id"][3:]) if last_cur else 0

    # Upsert curricula
    for r in normalized_rows:
        batch_id = batch_key_to_id[(r["batch_code"], r["program_id"])]
        term_id = r["term_id"]
        existing_cur = await db[COL_CURRICULUM].find_one(
            {"batch_id": batch_id, "term_id": term_id, "campus_id": campus_id}
        )
        if existing_cur:
            curriculum_id = existing_cur["curriculum_id"]
        else:
            next_cur_num += 1
            curriculum_id = f"CUR{next_cur_num:04d}"

        curriculum_doc = {
            "curriculum_id": curriculum_id,
            "batch_id": batch_id,
            "program_id": r["program_id"],
            "term_id": term_id,
            "campus_id": campus_id,
            "course_list": r["course_ids"],
            "created_at": existing_cur.get("created_at") if existing_cur else datetime.utcnow(),
            "updated_at": datetime.utcnow(),
        }
        await db[COL_CURRICULUM].update_one(
            {"curriculum_id": curriculum_id},
            {"$set": curriculum_doc},
            upsert=True,
        )

        # Link batch -> curriculum only for the intake term (earliest term in the import for that batch)
        intake_tid = intake_term_by_batch[(r["batch_code"], r["program_id"])]
        if term_id == intake_tid:
            await db[COL_BATCHES].update_one(
                {"batch_id": batch_id},
                {"$set": {"curriculum_id": curriculum_id, "updated_at": datetime.utcnow()}},
            )

        updated_curricula.append(
            {
                "batch_id": batch_id,
                "curriculum_id": curriculum_id,
                "course_count": len(r["course_ids"]),
                "term_id": term_id,
            }
        )

    return {
        "ok": True,
        "imported": len(updated_curricula),
        "created_batches": created_batches,
        "curricula": updated_curricula,
    }

async def campus_meta(campus_id: Optional[str]) -> Dict[str, str]:
    if not campus_id:
        return {"campus_id": "", "campus_name": ""}
    c = await db[COL_CAMPUSES].find_one(
        {"campus_id": campus_id}, {"_id": 0, "campus_id": 1, "campus_name": 1}
    )
    return c or {"campus_id": campus_id, "campus_name": ""}

def campus_section_prefix(campus_name: str) -> Optional[tuple[str, ...] | str]:
    n = (campus_name or "").lower()
    if "laguna" in n or "canlubang" in n or "binan" in n or "biñan" in n:
        # Accept both XX… and XC… section codes for Laguna
        return ("XX", "XC")
    if "manila" in n or "taft" in n:
        return "S"
    return None

# --- CBL helpers / prefix selection ---
def _is_cbl_program(program_name: Optional[str]) -> bool:
    if not program_name:
        return False
    return str(program_name).strip().upper().endswith("(CBL)")

def level_code(label_or_code: Optional[str]) -> str:
    v = (label_or_code or "").strip()
    u = v.upper()
    if u in {"UGS","UGB","UG","UNDERGRAD","UNDERGRADUATE"}:
        return "UGS"
    if u in {"GSM","GS","G","GRAD","GRADUATE"}:
        return "GSM"
    if v.lower().startswith("undergrad"):
        return "UGS"
    if v.lower().startswith("graduate"):
        return "GSM"
    return u

def campus_section_prefix_for_course(campus_name: str, level_or_code: Optional[str], program_name: Optional[str]) -> Optional[str]:
    n = (campus_name or "").lower()
    is_laguna = ("laguna" in n) or ("biñan" in n) or ("binan" in n) or ("canlubang" in n)
    is_manila = ("manila" in n) or ("taft" in n)

    norm = level_code(level_or_code)
    is_grad = (norm == "GSM")

    if is_manila:
        return "G" if is_grad else "S"
    if is_laguna:
        if is_grad:
            return "XX"
        return "XC" if _is_cbl_program(program_name) else "XX"
    return None

def prefix_pattern_for_level(campus_name: str, level_or_code: Optional[str]) -> str:
    n = (campus_name or "").lower()
    is_laguna = ("laguna" in n) or ("biñan" in n) or ("binan" in n) or ("canlubang" in n)
    is_manila = ("manila" in n) or ("taft" in n)
    norm = level_code(level_or_code)
    is_grad = (norm == "GSM")
    if is_manila:
        return "G" if is_grad else "S"
    if is_laguna:
        return "(XX|XC)" if not is_grad else "XX"
    return ""

def section_start_base(prefix: str) -> int:
    p = (prefix or "").upper()
    if p == "XX":
        return 21   # next -> XX22
    if p == "XC":
        return 22   # next -> XC23
    if p == "S":
        return 10   # next -> S11
    if p == "G":
        return 0    # next -> G01
    return 10

def format_section_code(prefix: str, number: int) -> str:
    p = (prefix or "").upper()
    if p == "G":
        return f"{prefix}{number:02d}"
    return f"{prefix}{number}"

DAY_NAME = {
    "M": "Monday", "MON": "Monday", "MONDAY": "Monday",
    "T": "Tuesday", "TU": "Tuesday", "TUE": "Tuesday",
    "W": "Wednesday", "WED": "Wednesday",
    "TH": "Thursday", "THU": "Thursday", "H": "Thursday", "R": "Thursday",
    "F": "Friday", "FRI": "Friday",
    "S": "Saturday", "SAT": "Saturday",
}
DOW = {"Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"}

def normalize_day(v: Any) -> str:
    if not v:
        return ""
    s = str(v).strip()
    if s in DOW:
        return s
    return DAY_NAME.get(s.upper(), s.title() if s.title() in DOW else s)

def _is_tba(v: Any) -> bool:
    return isinstance(v, str) and ("TBA" in v.upper())

def _clean_slot_inputs(s: Optional[dict], *, allow_time: bool) -> tuple[str, str, str, str, str]:
    """Return (day, start, end, room_id, room_type) with TBA/blank normalized to ''. """
    s = s or {}
    rid = (s.get("room_id") or "").strip()
    rtp = (s.get("room_type") or "").strip()
    day = (s.get("day") or "").strip() if allow_time else ""
    beg = (s.get("start_time") or "").strip() if allow_time else ""
    end = (s.get("end_time") or "").strip() if allow_time else ""

    if _is_tba(rid) or rid == "— TBA —":
        rid = ""
    if _is_tba(day) or _is_tba(beg) or _is_tba(end):
        day = beg = end = ""

    return day, beg, end, rid, rtp

def caps_name(u: Dict[str, Any]) -> str:
    first, last = (u.get("first_name") or "").strip(), (u.get("last_name") or "").strip()
    mid = (u.get("middle_name") or "").strip()
    return f"{last}, {first} {mid}".strip().upper() if mid else f"{last}, {first}".strip().upper()

def _sha1_of(obj: Any) -> str:
    b = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha1(b).hexdigest()

# ------------ Level mapping ------------
LEVEL_LABELS = {
    "UGS": "Undergraduate",
    "UGB": "Undergraduate",
    "UG":  "Undergraduate",
    "GSM": "Graduate Studies",
    "GS":  "Graduate Studies",
    "G":   "Graduate Studies",
}

def level_label(code: Optional[str]) -> str:
    c = (code or "").strip()
    u = c.upper()
    if u in LEVEL_LABELS:
        return LEVEL_LABELS[u]
    lc = c.lower()
    if lc.startswith("undergrad"):
        return "Undergraduate"
    if lc.startswith("graduate"):
        return "Graduate Studies"
    return c

# ------------ editing rules (type_of_course) ------------
EDIT_FULL = {"GE", "SHS"}  # full-row edit (faculty, day/time, etc.)
EDIT_LIMITED = {"MAJOR", "FOUNDATION", "ELECTIVE", "COS", "ELECTIVE COURSE"}

async def _course_type(course_id: str) -> str:
    if not course_id:
        return ""
    d = await db[COL_COURSES].find_one({"course_id": course_id}, {"_id": 0, "type_of_course": 1})
    return canonical_course_type((d or {}).get("type_of_course"))

# ------------ NEW: program + course helpers ------------
async def _course_program_level(course_id: Optional[str]) -> Optional[str]:
    if not course_id:
        return None
    d = await db[COL_COURSES].find_one({"course_id": course_id}, {"_id":0,"program_level":1})
    return (d or {}).get("program_level")

async def _program_name(program_id: Optional[str]) -> Optional[str]:
    if not program_id:
        return None
    d = await db[COL_PROGRAMS].find_one({"program_id": program_id}, {"_id":0,"program_name":1})
    return (d or {}).get("program_name")

# ------------ name parsing & faculty resolution helpers ------------
def _parse_person_name(name: str) -> Optional[Dict[str, str]]:
    """Accepts 'LAST, First Middle' or 'First Middle Last'."""
    if not name:
        return None
    s = " ".join(str(name).strip().split())
    if not s:
        return None
    first = ""; middle = ""; last = ""
    if "," in s:
        parts = [p.strip() for p in s.split(",", 1)]
        last = parts[0]
        rest = parts[1] if len(parts) > 1 else ""
        bits = rest.split()
        if bits:
            first = bits[0]
            if len(bits) > 1:
                middle = " ".join(bits[1:])
    else:
        bits = s.split()
        if len(bits) == 1:
            first = bits[0]
        elif len(bits) == 2:
            first, last = bits[0], bits[1]
        else:
            first = bits[0]; last = bits[-1]; middle = " ".join(bits[1:-1])

    def cap(x: str) -> str:
        return " ".join(w.capitalize() for w in x.split())

    return {
        "first_name": cap(first),
        "middle_name": cap(middle),
        "last_name": cap(last),
    }

def normalize_level(x: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    t = (x or "").strip().lower()
    if not t:
        return (None, None)
    if t in {"ug", "ugb", "undergrad", "undergraduate", "undergraduate studies"}:
        return ("Undergraduate", "UG")
    if t in {"gs", "gsm", "grad", "graduate", "graduate studies"}:
        return ("Graduate", "GS")
    if "undergrad" in t:
        return ("Undergraduate", "UG")
    if "graduate" in t:
        return ("Graduate", "GS")
    return (x, None)

def expected_section_prefix(campus_name: str, level_label: Optional[str]) -> str:
    c = (campus_name or "").strip().upper()
    l = (level_label or "").strip().lower()
    if l == "graduate":
        return "G"
    if c == "LAGUNA":
        return "XX"
    return "S"

async def _resolve_or_create_faculty_by_name(name: str) -> Tuple[Optional[str], Optional[str]]:
    """
    Given a free-text faculty name from the UI, resolve or create:
      • a USERS row (user_id) with first_name / last_name only
      • a FACULTY_PROFILES row (faculty_id) linked via user_id

    Returns: (user_id, faculty_id)
    """
    nm = _parse_person_name(name)
    if not nm:
        return (None, None)

    first = (nm.get("first_name") or "").strip()
    last = (nm.get("last_name") or "").strip()

    if not first and not last:
        return (None, None)

    def _eq_ci(field: str, val: str) -> Dict[str, Any]:
        return {field: {"$regex": f"^{re.escape(val)}$", "$options": "i"}}

    async def _create_user_stub(first_name: str, last_name: str) -> str:
        """
        Create a minimal USERS row that matches your sample:

          users {
            "user_id": "USR####",
            "email": "",                 # keep other fields null/empty
            "first_name": "...",
            "last_name": "...",
            "status": true,
            "profile_image": "",
            "created_at": now(),
            "last_login": now()
          }
        """
        uid = await _next_seq_id(COL_USERS, "user_id", "USR", 4)
        user_doc = {
            "user_id": uid,
            "email": "",
            "first_name": first_name,
            "last_name": last_name,
            "status": True,
            "profile_image": "",
            "created_at": now(),
            "last_login": now(),
        }
        await db[COL_USERS].insert_one(user_doc)
        return uid

    async def _create_faculty_profile_stub(user_id: str) -> str:
        """
        Create a FACULTY_PROFILES row that matches your sample shape:

          faculty_profiles {
            "faculty_id": "FAC####",
            "user_id": "USR####",
            "employment_type": "",
            "min_units": "",
            "max_preps": None,
            "certifications": [],
            "qualified_kacs": [],
            "teaching_years": None,
            "department_id": "",
            "fac_position": "",
            "created_at": now(),
            "updated_at": now()
          }
        """
        fid = await _next_seq_id(COL_FAC_PROFILES, "faculty_id", "FAC", 4)
        fac_doc = {
            "faculty_id": fid,
            "user_id": user_id,
            "employment_type": "",
            "min_units": "",
            "max_preps": None,
            "certifications": [],
            "qualified_kacs": [],
            "teaching_years": None,
            "department_id": "",
            "fac_position": "",
            "created_at": now(),
            "updated_at": now(),
        }
        await db[COL_FAC_PROFILES].insert_one(fac_doc)
        return fid

    # ---------- 1) Try to find an existing USER by first/last name ----------
    users_q: Dict[str, Any] = {}
    if first:
        users_q.update(_eq_ci("first_name", first))
    if last:
        users_q.update(_eq_ci("last_name", last))

    user_id: Optional[str] = None
    faculty_id: Optional[str] = None

    if users_q:
        u = await db[COL_USERS].find_one(users_q, {"_id": 0, "user_id": 1})
        if u and u.get("user_id"):
            user_id = u["user_id"]

    if user_id:
        # If a USER exists, either re-use or create a FACULTY_PROFILE linked to it
        fp = await db[COL_FAC_PROFILES].find_one(
            {"user_id": user_id},
            {"_id": 0, "faculty_id": 1},
        )
        if fp and fp.get("faculty_id"):
            faculty_id = fp["faculty_id"]
        else:
            faculty_id = await _create_faculty_profile_stub(user_id)
        return (user_id, faculty_id)

    # ---------- 2) Legacy fallback: faculty_profiles that stored names ----------
    # (some old data may have first_name / last_name in faculty_profiles)
    fac_q: Dict[str, Any] = {}
    if first:
        fac_q.update(_eq_ci("first_name", first))
    if last:
        fac_q.update(_eq_ci("last_name", last))

    fp_legacy = None
    if fac_q:
        fp_legacy = await db[COL_FAC_PROFILES].find_one(
            fac_q,
            {"_id": 0, "faculty_id": 1, "user_id": 1},
        )

    if fp_legacy:
        faculty_id = fp_legacy.get("faculty_id")
        user_id = fp_legacy.get("user_id")

        # If the legacy faculty_profile has no user_id, create one and link it.
        if not user_id:
            user_id = await _create_user_stub(first, last)
            await db[COL_FAC_PROFILES].update_one(
                {"faculty_id": faculty_id},
                {"$set": {"user_id": user_id, "updated_at": now()}},
            )
        return (user_id, faculty_id)

    # ---------- 3) No matches: create BOTH user and faculty_profile ----------
    user_id = await _create_user_stub(first, last)
    faculty_id = await _create_faculty_profile_stub(user_id)
    return (user_id, faculty_id)

# ------------ mappers ------------
async def map_courses(course_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    if not course_ids:
        return out
    cur = db[COL_COURSES].find(
        {"course_id": {"$in": course_ids}},
        {
            "_id": 0,
            "course_id": 1,
            "course_code": 1,
            "course_title": 1,
            "department_id": 1,
            "program_level": 1,
            "units": 1,
            "type_of_course": 1,
        },
    )
    async for c in cur:
        code = c.get("course_code")
        if isinstance(code, list):
            code = code[0] if code else ""
        out[c["course_id"]] = {
            "course_code": code if isinstance(code, str) else "",
            "course_title": c.get("course_title", ""),
            "department_id": c.get("department_id", ""),
            "program_level": c.get("program_level", ""),
            "program_level_label": level_label(c.get("program_level")),
            "units": c.get("units"),
            "type_of_course": c.get("type_of_course", ""),
        }
    return out

async def map_departments(dep_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    if not dep_ids:
        return out
    cur = db[COL_DEPARTMENTS].find(
        {"department_id": {"$in": dep_ids}},
        {"_id": 0, "department_id": 1, "department_name": 1, "dept_name": 1},
    )
    async for d in cur:
        out[d["department_id"]] = {
            "department_name": d.get("department_name") or d.get("dept_name") or ""
        }
    return out

def _extract_batch_number(b: Dict[str, Any]) -> Optional[int]:
    n = b.get("batch_number")
    try:
        if n is not None:
            return int(n)
    except Exception:
        pass
    code = (b.get("batch_code") or "").upper()
    m = re.search(r"(\d+)", code)
    return int(m.group(1)) if m else None

async def map_batches() -> Tuple[Dict[int, Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    by_number: Dict[int, Dict[str, Any]] = {}
    by_id: Dict[str, Dict[str, Any]] = {}
    cur = db[COL_BATCHES].find({}, {"_id": 0, "batch_id": 1, "batch_number": 1, "batch_code": 1})
    async for b in cur:
        n = _extract_batch_number(b)
        if n is not None:
            b["batch_number"] = n
        by_number[n or -1] = b
        by_id[b["batch_id"]] = b
    return by_number, by_id

async def map_programs(p_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    if not p_ids:
        return out
    cur = db[COL_PROGRAMS].find(
        {"program_id": {"$in": p_ids}},
        {"_id": 0, "program_id": 1, "program_code": 1, "department_id": 1, "program_name": 1},
    )
    async for p in cur:
        out[p["program_id"]] = {
            "program_code": p.get("program_code", ""),
            "department_id": p.get("department_id", ""),
            "program_name": p.get("program_name", ""),
        }
    return out

# ---------- demand helpers ----------
async def preen_total_for_course(term_id: str, campus_id: Optional[str], course_id: str) -> int:
    """
    Sum pre-enlistment demand for a course.

    IMPORTANT:
    - If preenlistment_count docs are campus-scoped (have campus_id in this term),
      we must NOT fall back to other campuses when this campus has no rows.
    - If this is a legacy dataset where campus_id is not stored, we fall back to term-wide rows.
    """
    base_cond: Dict[str, Any] = {"course_id": course_id, "term_id": term_id, "is_archived": {"$ne": True}}

    async def _sum(cond: Dict[str, Any]) -> int:
        total = 0
        async for r in db[COL_PREEN].find(cond, {"_id": 0, "preenlistment_count": 1, "count": 1}):
            total += int(r.get("preenlistment_count") or r.get("count") or 0)
        return total

    if campus_id:
        campus_cond = {**base_cond, "campus_id": campus_id}
        total = await _sum(campus_cond)
        if total > 0:
            return total

        # No rows for this campus. Only fall back if the dataset is legacy (no campus_id stored at all for this term).
        term_has_any_campus = await db[COL_PREEN].count_documents(
            {"term_id": term_id, "is_archived": {"$ne": True}, "campus_id": {"$exists": True, "$ne": ""}}
        ) > 0
        if term_has_any_campus:
            return 0

    return await _sum(base_cond)

async def _program_latest_batch_number(program_id: str, campus_id: Optional[str]) -> Optional[int]:
    qs: Dict[str, Any] = {"program_id": program_id}
    if campus_id:
        qs["campus_id"] = campus_id
    latest = None
    cur = db[COL_BATCHES].find(qs, {"_id": 0, "batch_number": 1, "batch_code": 1})
    async for b in cur:
        n = _extract_batch_number(b)
        if n is not None:
            latest = n if latest is None else max(latest, n)
    return latest

def _year_level_name(batch_num: Optional[int], latest_num: Optional[int]) -> Optional[str]:
    if batch_num is None or latest_num is None:
        return None
    diff = latest_num - batch_num
    if diff <= 0:
        return "freshman"
    if diff == 1:
        return "sophomore"
    if diff == 2:
        return "junior"
    return "senior"

async def _program_stats_doc(term_id: str, program_id: str, _campus_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    proj = {"_id": 0, "freshman": 1, "sophomore": 1, "junior": 1, "senior": 1, "enrollment": 1}
    doc = await db[COL_PREEN_STATS].find_one({"term_id": term_id, "program_id": program_id}, proj)
    if doc:
        return doc
    prog = await db[COL_PROGRAMS].find_one({"program_id": program_id}, {"_id": 0, "program_code": 1})
    pcode = (prog or {}).get("program_code")
    if pcode:
        doc = await db[COL_PREEN_STATS].find_one({"term_id": term_id, "program_code": pcode}, proj)
        if doc:
            return doc
    return None

async def _estimate_cohort_demand_for_course(term_id: str, campus_id: Optional[str], course_id: str) -> int:
    q: Dict[str, Any] = {"term_id": term_id, "course_list": course_id}
    if campus_id:
        q["campus_id"] = campus_id
    currs = [x async for x in db[COL_CURRICULUM].find(q, {"_id": 0, "program_id": 1, "batch_id": 1})]
    if not currs:
        return 0

    batch_ids = [c.get("batch_id") for c in currs if c.get("batch_id")]
    by_id: Dict[str, Dict[str, Any]] = {}
    if batch_ids:
        async for b in db[COL_BATCHES].find(
            {"batch_id": {"$in": batch_ids}},
            {"_id": 0, "batch_id": 1, "batch_code": 1, "batch_number": 1},
        ):
            by_id[b["batch_id"]] = b

    grouped: Dict[str, Dict[str, List[str]]] = {}
    latest_cache: Dict[str, Optional[int]] = {}
    for c in currs:
        pid, bid = c.get("program_id"), c.get("batch_id")
        if not pid or not bid:
            continue
        if pid not in latest_cache:
            latest_cache[pid] = await _program_latest_batch_number(pid, campus_id)
        bn = _extract_batch_number(by_id.get(bid, {}))
        lvl = _year_level_name(bn, latest_cache[pid])
        if not lvl:
            continue
        grouped.setdefault(pid, {}).setdefault(lvl, []).append(bid)

    total = 0
    for pid, levels in grouped.items():
        stats = await _program_stats_doc(term_id, pid)
        if not stats:
            continue
        for lvl, bids in levels.items():
            lvl_count = int(stats.get(lvl, 0) or 0)
            denom = max(len(bids), 1)
            per_batch = (lvl_count + denom - 1) // denom
            total += per_batch * len(bids)
    return total

async def estimated_demand(term_id: str, campus_id: Optional[str], course_id: str) -> Dict[str, int]:
    preen = await preen_total_for_course(term_id, campus_id, course_id)
    cohort = await _estimate_cohort_demand_for_course(term_id, campus_id, course_id)
    plan = max(preen, cohort)
    return {"preen": preen, "cohort": cohort, "plan": plan}

# ---------- section numbering / safety ----------
async def _max_section_number(prefix: str, term_id: str, course_id: str, default_when_empty: int = 10) -> int:
    if not prefix:
        return default_when_empty
    pat = {"$regex": f"^{prefix}\\d+$", "$options": "i"}
    nums: List[int] = []
    cur = db[COL_SECTIONS].find(
        {"term_id": term_id, "course_id": course_id, "section_code": pat},
        {"_id": 0, "section_code": 1},
    )
    async for s in cur:
        code = (s.get("section_code") or "").upper()
        digits = "".join(ch for ch in code if ch.isdigit())
        if digits.isdigit():
            nums.append(int(digits))
    return max(nums) if nums else default_when_empty

async def next_section_code(prefix: str, term_id: str, course_id: str) -> str:
    base_when_empty = section_start_base(prefix)
    start = await _max_section_number(prefix, term_id, course_id, default_when_empty=base_when_empty) + 1
    return format_section_code(prefix, start) if prefix else ""

async def safe_insert_section(doc: Dict[str, Any]) -> Optional[str]:
    retries = 6
    user_code = bool(doc.pop("_code_from_user", False))
    for _ in range(retries):
        try:
            await db[COL_SECTIONS].insert_one(doc)
            return doc["section_id"]
        except DuplicateKeyError:
            if user_code:
                return None
            prefix = re.match(r"^[A-Za-z]+", doc.get("section_code","")).group(0) if doc.get("section_code") else ""
            base_when_empty = section_start_base(prefix)
            maxn = await _max_section_number(prefix, doc["term_id"], doc["course_id"], default_when_empty=base_when_empty)
            doc["section_code"] = format_section_code(prefix, maxn + 1)
    return None

# ---------- OVERRIDE infra ----------
def _make_token() -> str:
    return "ovr_" + secrets.token_urlsafe(20)

async def issue_override_token(*, user_id: str, payload: Dict[str, Any], violations: List[Dict[str, Any]], ttl_sec: int = 300) -> str:
    tok = _make_token()
    await db[COL_OVR_TOKENS].insert_one({
        "token": tok, "user_id": user_id, "violations": violations, "payload": payload,
        "expires_at": now() + timedelta(seconds=ttl_sec), "created_at": now(),
    })
    return tok

async def assert_override_token(token: str, user_id: str) -> Dict[str, Any]:
    doc = await db[COL_OVR_TOKENS].find_one({"token": token, "user_id": user_id})
    if not doc:
        raise HTTPException(status_code=409, detail="Invalid override token.")
    if doc.get("expires_at") and doc["expires_at"] < now():
        await db[COL_OVR_TOKENS].delete_one({"_id": doc["_id"]})
        raise HTTPException(status_code=409, detail="Override token expired.")
    await db[COL_OVR_TOKENS].delete_one({"_id": doc["_id"]})
    return {"violations": doc.get("violations") or [], "payload": doc.get("payload") or {}}

async def audit_override(*, user_id: str, action: str, reason: str, violations: List[Dict[str, Any]], payload: Dict[str, Any]):
    await db[COL_OVR_AUDIT].insert_one({
        "audit_id": _id("OVR-"),
        "user_id": user_id,
        "action": action,
        "reason": (reason or "").strip(),
        "violations": violations,
        "payload": payload,
        "created_at": now(),
    })

# ---------- SOFT/HARD validation ----------
async def validate_hard_errors(action: str, payload: Dict[str, Any], term_id: str) -> List[Dict[str, str]]:
    errs: List[Dict[str, str]] = []
    def err(code: str, msg: str):
        errs.append({"code": code, "message": msg})

    # ELECTIVE handling
    if action in {"addRow", "editRow"}:
        course_id = (payload.get("course_id") or payload.get("links", {}).get("course_id") or "").strip()
        placeholder_id = (payload.get("for_placeholder_course_id") or "").strip()
        specific_id    = (payload.get("specific_course_id") or "").strip()

        if action == "addRow":
            if not course_id and not (placeholder_id and specific_id):
                err("COURSE_REQUIRED", "Provide course_id, or for_placeholder_course_id + specific_course_id for electives.")
            else:
                if course_id and (not await db[COL_COURSES].find_one({"course_id": course_id})):
                    err("COURSE_NOT_FOUND", "Invalid course_id.")
                if placeholder_id:
                    ph = await db[COL_COURSES].find_one({"course_id": placeholder_id}, {"_id": 0, "type_of_course": 1})
                    if not ph or _ctype(ph.get("type_of_course")) != ELECTIVE_PLACEHOLDER:
                        err("ELECTIVE_PLACEHOLDER_INVALID", "for_placeholder_course_id must be 'Elective'.")
                if specific_id:
                    sc = await db[COL_COURSES].find_one({"course_id": specific_id}, {"_id": 0, "type_of_course": 1})
                    if not sc or _ctype(sc.get("type_of_course")) != ELECTIVE_SPECIFIC:
                        err("ELECTIVE_SPECIFIC_INVALID", "specific_course_id must have type_of_course = 'Elective Course'.")

        if action == "editRow":
            if specific_id:
                sc = await db[COL_COURSES].find_one({"course_id": specific_id}, {"_id": 0, "type_of_course": 1})
                if not sc or _ctype(sc.get("type_of_course")) != ELECTIVE_SPECIFIC:
                    err("ELECTIVE_SPECIFIC_INVALID", "specific_course_id must have type_of_course = 'Elective Course'.")
            if placeholder_id:
                ph = await db[COL_COURSES].find_one({"course_id": placeholder_id}, {"_id": 0, "type_of_course": 1})
                if not ph or _ctype(ph.get("type_of_course")) != ELECTIVE_PLACEHOLDER:
                    err("ELECTIVE_PLACEHOLDER_INVALID", "for_placeholder_course_id must be 'Elective'.")

        # Room/time validations
        for idx, key in enumerate(["slot1", "slot2"], start=1):
            s = (payload.get(key) or {}) if isinstance(payload.get(key), dict) else {}
            rid = (s.get("room_id") or "").strip()
            has_time = bool((s.get("day") or "").strip() and (s.get("start_time") or "").strip() and (s.get("end_time") or "").strip())

            if not rid:
                continue

            if action == "addRow":
                if not has_time:
                    err("ROOM_REQUIRES_TIME", f"{key}: room requires day/start_time/end_time.")
            else:
                section_id = (payload.get("section_id") or "").strip()
                if not has_time and section_id:
                    sid_tag = _sched_id_for_section(section_id, idx)
                    existing = await db[COL_SCHEDS].find_one(
                        {"section_id": section_id, "schedule_id": sid_tag},
                        {"_id": 0, "day": 1, "start_time": 1, "end_time": 1}
                    )
                    existing_has_time = bool(existing and (existing.get("day") and existing.get("start_time") and existing.get("end_time")))
                    if not existing_has_time:
                        err("ROOM_REQUIRES_TIME", f"{key}: room requires day/start_time/end_time.")

            # Capacity/room_type checks
            cap_eff = None
            if action == "addRow":
                add_cap = payload.get("enrollment_cap")
                if add_cap in (None, ""):
                    _raw_course = (payload.get("course_id") or payload.get("links", {}).get("course_id") or "").strip()
                    _ph = (payload.get("for_placeholder_course_id") or "").strip()
                    _spec = (payload.get("specific_course_id") or "").strip()
                    target_cid = _spec or _raw_course or _ph
                    cap_eff = await default_capacity_for_course(target_cid) if target_cid else DEFAULT_CAP
                else:
                    cap_eff = int(add_cap)
            else:
                if "enrollment_cap" in payload and payload.get("enrollment_cap") not in (None, ""):
                    cap_eff = int(payload.get("enrollment_cap"))
                else:
                    _sec = await db[COL_SECTIONS].find_one(
                        {"section_id": (payload.get("section_id") or "").strip()},
                        {"_id": 0, "enrollment_cap": 1}
                    )
                    cap_eff = int((_sec or {}).get("enrollment_cap") or DEFAULT_CAP)

            room = await db[COL_ROOMS].find_one({"room_id": rid}, {"_id": 0, "capacity": 1, "room_type": 1, "room_number": 1})
            if not room:
                err("ROOM_NOT_FOUND", f"{key}: room not found.")
            else:
                try:
                    rcap = int(room.get("capacity") or 0)
                except Exception:
                    rcap = 0
                if rcap and cap_eff and rcap < cap_eff:
                    err("ROOM_TOO_SMALL", f"{key}: room capacity {rcap} < section capacity {cap_eff}.")

                req_type = (s.get("room_type") or "").strip()
                rtype = (room.get("room_type") or "").strip()
                if req_type and rtype and req_type.lower() != rtype.lower():
                    err("ROOM_TYPE_MISMATCH", f"{key}: room_type '{req_type}' does not match room’s type '{rtype}'.")

    if action in {"addRow"}:
        batch_id = (payload.get("batch_id") or "").strip()
        if not batch_id or not await db[COL_BATCHES].find_one({"batch_id": batch_id}):
            errs.append({"code": "BATCH_NOT_FOUND", "message": "Invalid batch_id."})

    if action in {"editRow", "deleteRow"}:
        section_id = (payload.get("section_id") or "").strip()
        if not section_id:
            errs.append({"code": "SECTION_REQUIRED", "message": "section_id is required."})
        else:
            if not await db[COL_SECTIONS].find_one({"section_id": section_id, "term_id": term_id}):
                errs.append({"code": "SECTION_NOT_FOUND", "message": "Section not found for current term."})

    if "enrollment_cap" in payload:
        cap = payload.get("enrollment_cap")
        if cap not in (None, ""):
            try:
                cap = int(cap)
            except Exception:
                errs.append({"code": "CAPACITY_INVALID", "message": "enrollment_cap must be a number."})
            else:
                if cap < 0:
                    errs.append({"code": "CAPACITY_NEGATIVE", "message": "enrollment_cap cannot be negative."})

    if action in {"addRow", "editRow"} and payload.get("section_code"):
        _raw_course = (payload.get("course_id") or payload.get("links", {}).get("course_id") or "").strip()
        _ph = (payload.get("for_placeholder_course_id") or "").strip()
        _spec = (payload.get("specific_course_id") or "").strip()
        target_cid = _spec or _raw_course

        ctype = await _course_type(target_cid) if target_cid else ""
        if ctype not in EDIT_FULL:
            q = {"term_id": term_id, "course_id": target_cid, "section_code": payload["section_code"].strip()}
            if action == "editRow":
                q["section_id"] = {"$ne": payload.get("section_id")}
            if target_cid and await db[COL_SECTIONS].find_one(q):
                errs.append({"code": "SECTION_CODE_DUP", "message": "Section code already in use for this course and term."})

    return errs

async def validate_soft_conflicts(
    *, action: str, payload: Dict[str, Any], campus_name: str, term_id: str, campus_id: Optional[str],
) -> List[Dict[str, Any]]:
    conf: List[Dict[str, Any]] = []
    def warn(code: str, msg: str, data: Optional[Dict[str, Any]] = None):
        item = {"code": code, "level": "warning", "message": msg}
        if data:
            item["data"] = data
        conf.append(item)

    placeholder_id = (payload.get("for_placeholder_course_id") or "").strip()
    course_id_fallback = (payload.get("course_id") or payload.get("links", {}).get("course_id") or "").strip()

    if not placeholder_id and action in {"editRow", "deleteRow"} and payload.get("section_id"):
        sec_doc = await db[COL_SECTIONS].find_one(
            {"section_id": (payload.get("section_id") or "").strip()},
            {"_id": 0, "fulfilled_placeholder_course_id": 1, "course_id": 1}
        )
        placeholder_id = (sec_doc or {}).get("fulfilled_placeholder_course_id", "") or ""

    plan_cid = placeholder_id or course_id_fallback
    plan_lvl = await _course_program_level(plan_cid) if plan_cid else None

    ctype = (await _course_type(plan_cid)) if plan_cid else ""
    if ctype in EDIT_FULL:
        return []

    prog_id = (payload.get("program_id") or payload.get("links", {}).get("program_id") or "").strip()
    prog_name = await _program_name(prog_id) if prog_id else None

    expected_prefix = campus_section_prefix_for_course(campus_name, plan_lvl, prog_name) or campus_section_prefix(campus_name) or ""

    sec_code = (payload.get("section_code") or "").strip()
    if sec_code:
        if expected_prefix and not sec_code.upper().startswith(expected_prefix):
            warn("PREFIX_MISMATCH", f"Section code doesn't start with '{expected_prefix}'.", {"section_code": sec_code})
        if not re.search(r"\d", sec_code):
            warn("CODE_WITHOUT_NUMBER", "Section code has no numeric part (e.g., S11 / XX22 / XC23 / G01).", {"section_code": sec_code})

    s1 = (payload.get("slot1") or {})
    s2 = (payload.get("slot2") or {})
    if (s1.get("room_id") in (None, "")) and (s2.get("room_id") in (None, "")):
        warn("NO_ROOM_SET", "No room selected yet (TBA).")

    if plan_cid:
        # Exclude soft-deleted (archived) sections from capacity math.
        # Otherwise, deleted sections still count towards capacity and can also keep showing in the UI.
        sec_q: Dict[str, Any] = {"term_id": term_id, "campus_id": campus_id, "status": {"$ne": "archived"}}
        sec_q["$or"] = [{"course_id": plan_cid}, {"fulfilled_placeholder_course_id": plan_cid}]

        pref_pat = prefix_pattern_for_level(campus_name, plan_lvl)
        if pref_pat:
            sec_q["section_code"] = {"$regex": f"^{pref_pat}", "$options": "i"}

        planned_cap = 0
        async for s in db[COL_SECTIONS].find(sec_q, {"_id": 0, "enrollment_cap": 1}):
            planned_cap += int(s.get("enrollment_cap") or DEFAULT_CAP)

        cap_delta = 0
        if action == "addRow":
            add_cap = payload.get("enrollment_cap")
            if add_cap in (None, ""):
                add_cap = await default_capacity_for_course(plan_cid) if plan_cid else DEFAULT_CAP
            cap_delta += int(add_cap)
        if action == "editRow" and "enrollment_cap" in payload and payload.get("enrollment_cap") not in (None, ""):
            old = await db[COL_SECTIONS].find_one({"section_id": payload.get("section_id")}, {"_id": 0, "enrollment_cap": 1})
            old_cap = int((old or {}).get("enrollment_cap") or DEFAULT_CAP)
            new_cap = int(payload.get("enrollment_cap"))
            cap_delta += (new_cap - old_cap)
        if action == "deleteRow":
            old = await db[COL_SECTIONS].find_one({"section_id": payload.get("section_id")}, {"_id": 0, "enrollment_cap": 1})
            if old:
                cap_delta -= int(old.get("enrollment_cap") or DEFAULT_CAP)

        est = await estimated_demand(term_id, campus_id, plan_cid)
        total_intent = est["plan"]

        if not payload.get("auto_approve"):
            after_cap = planned_cap + cap_delta
            if after_cap < total_intent:
                warn(
                    "SEAT_DEFICIT",
                    f"Capacity below demand by {total_intent - after_cap}",
                    {"planned_after": after_cap, "demand_plan": total_intent, "preen": est["preen"], "cohort": est["cohort"]},
                )

    if action == "deleteRow" and payload.get("section_id"):
        sid = payload["section_id"]
        if await db[COL_FAC_ASSIGN].find_one({"section_id": sid, "is_archived": {"$ne": True}}):
            warn("HAS_FACULTY_ASSIGN", "This section has faculty assignment; deleting will archive it.")
        if await db[COL_SCHEDS].find_one({"section_id": sid}):
            warn("HAS_SCHEDULES", "This section has schedules; deleting will remove them.")

    return conf

# ---------- deterministic seating / helpers ----------
def _sort_sections_by_number(sections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    def num(s):
        code = (s.get("section_code") or "").upper()
        d = "".join(ch for ch in code if ch.isdigit())
        try:
            return int(d)
        except Exception:
            return 0
    return sorted(sections, key=num)

def _assign_blocks_to_sections(
    block_keys: List[Tuple[str, str, str, int]],
    sections: List[Dict[str, Any]]
) -> Dict[Tuple[str, str], Optional[Dict[str, Any]]]:
    by_bn: Dict[int, List[Dict[str, Any]]] = {}
    legacy: List[Dict[str, Any]] = []
    for s in _sort_sections_by_number(sections):
        bn = s.get("batch_number")
        if isinstance(bn, int):
            by_bn.setdefault(bn, []).append(s)
        else:
            legacy.append(s)

    seating: Dict[Tuple[str, str], Optional[Dict[str, Any]]] = {}
    used: set = set()
    for (bid, pid, _label, bn) in block_keys:
        match = None
        if isinstance(bn, int) and bn in by_bn:
            for s in by_bn[bn]:
                if s["section_id"] not in used:
                    match = s
                    break
        if not match and legacy:
            while legacy and legacy[0]["section_id"] in used:
                legacy.pop(0)
            if legacy:
                match = legacy.pop(0)
        seating[(bid, pid)] = match
        if match:
            used.add(match["section_id"])
    return seating

def _unique_owners_in_order(keys: List[Tuple[str, str, str, int]]) -> List[Tuple[str, str, int]]:
    seen = set()
    out: List[Tuple[str, str, int]] = []
    for (bid, pid, _label, bn) in keys:
        k = (bid, pid)
        if k not in seen:
            seen.add(k)
            out.append((bid, pid, int(bn) if isinstance(bn, int) else 0))
    return out

def _distribute_sections_round_robin(
    sections: List[Dict[str, Any]],
    owners: List[Tuple[str, str, int]]
) -> Dict[Tuple[str, str], List[Dict[str, Any]]]:
    secs = _sort_sections_by_number(sections)
    if not owners:
        return {}
    n = len(owners)
    alloc: Dict[Tuple[str, str], List[Dict[str, Any]]] = {(bid, pid): [] for (bid, pid, _bn) in owners}
    for idx, s in enumerate(secs):
        (bid, pid, _bn) = owners[idx % n]
        alloc[(bid, pid)].append(s)
    return alloc

# ---------- ensure sections by demand ----------
async def ensure_sections_from_demand(
    *, term_id: str, campus_id: str, campus_prefix: str, course_id: str, base_per_program: int, capacity: int = DEFAULT_CAP
) -> None:
    q: Dict[str, Any] = {"term_id": term_id, "campus_id": campus_id, "status": {"$ne": "archived"}, "$or": [{"course_id": course_id}, {"fulfilled_placeholder_course_id": course_id}]}
    if campus_prefix:
        q["section_code"] = {"$regex": f"^{campus_prefix}", "$options": "i"}
    existing = await db[COL_SECTIONS].count_documents(q)

    est = await estimated_demand(term_id, campus_id, course_id)
    total = int(est["plan"] or 0)
    needed_by_demand = max(1, ceil((total or 0) / (capacity or DEFAULT_CAP)))
    needed = max(base_per_program, needed_by_demand)

    if existing < base_per_program:
        to_make = base_per_program - existing
        for _ in range(to_make):
            code = await next_section_code(campus_prefix, term_id, course_id)
            sid = await _next_seq_id(COL_SECTIONS, "section_id", "SEC", 4)
            doc = {
                "section_id": sid,
                "section_code": code,
                "course_id": course_id,
                "term_id": term_id,
                "campus_id": campus_id,
                "enrollment_cap": capacity,
                "remarks": "",
                "enrolled": None,
                "status": "active",
                "created_at": now(), "updated_at": now(),
            }
            inserted = await safe_insert_section(doc)
            if inserted:
                await _provision_sched_and_assignment_for_new_section(doc)
        existing += to_make

    if existing < needed:
        for _ in range(needed - existing):
            code = await next_section_code(campus_prefix, term_id, course_id)
            sid = await _next_seq_id(COL_SECTIONS, "section_id", "SEC", 4)
            doc = {
                "section_id": sid,
                "section_code": code,
                "course_id": course_id,
                "term_id": term_id,
                "campus_id": campus_id,
                "enrollment_cap": capacity,
                "remarks": "",
                "created_at": now(), "updated_at": now(),
            }
            if await safe_insert_section(doc):
                await _provision_sched_and_assignment_for_new_section(doc)

async def _create_sections(
    *, term_id: str, campus_id: str, campus_prefix: str, course_id: str,
    count: int, capacity: int = DEFAULT_CAP,
    owners: Optional[List[Tuple[str, str, int]]] = None,
) -> int:
    made = 0
    owners = owners or []
    for i in range(max(0, int(count))):
        code = await next_section_code(campus_prefix, term_id, course_id)
        sid = await _next_seq_id(COL_SECTIONS, "section_id", "SEC", 4)

        doc = {
            "section_id": sid,
            "section_code": code,
            "course_id": course_id,
            "term_id": term_id,
            "campus_id": campus_id,
            "enrollment_cap": capacity,
            "remarks": "",
            "enrolled": None,
            "status": "active",
            "created_at": now(),
            "updated_at": now(),

            "owner_batch_id": None,
            "owner_program_id": None,
            "batch_number": None,
        }

        if owners:
            bid, pid, bn = owners[i % len(owners)]
            doc["owner_batch_id"] = bid or None
            doc["owner_program_id"] = pid or None
            doc["batch_number"] = int(bn or 0)

        if await safe_insert_section(doc):
            await _provision_sched_and_assignment_for_new_section(doc)
            made += 1
    return made

async def reduce_sections_if_excess(
    *, term_id: str, campus_id: str, campus_prefix: str, course_id: str, target_count: int
) -> int:
    """
    Reduce (hard-delete) excess sections for a course when planning updates are approved.

    Placeholder schedules (all None) and placeholder faculty assignments (no user/faculty)
    should NOT block reduction.
    """
    q: Dict[str, Any] = {
        "term_id": term_id,
        "campus_id": campus_id,
        "status": {"$ne": "archived"},
        "$or": [{"course_id": course_id}, {"fulfilled_placeholder_course_id": course_id}],
    }
    if campus_prefix:
        q["section_code"] = {"$regex": f"^{campus_prefix}", "$options": "i"}

    secs = [s async for s in db[COL_SECTIONS].find(q, {"_id": 0, "section_id": 1, "section_code": 1})]
    secs = sorted(
        secs,
        key=lambda s: int("".join(ch for ch in (s.get("section_code", "")) if ch.isdigit()) or "0"),
        reverse=True,
    )
    cur_count = len(secs)
    if cur_count <= target_count:
        return 0

    async def _has_real_schedule(section_id: str) -> bool:
        async for sch in db[COL_SCHEDS].find(
            {"section_id": section_id},
            {"_id": 0, "day": 1, "start_time": 1, "end_time": 1, "room_id": 1},
        ):
            day = sch.get("day")
            st = sch.get("start_time")
            en = sch.get("end_time")
            rid = sch.get("room_id")
            if day or st or en or rid:
                return True
        return False

    async def _has_real_faculty(section_id: str) -> bool:
        async for a in db[COL_FAC_ASSIGN].find(
            {"section_id": section_id, "is_archived": {"$ne": True}},
            {"_id": 0, "user_id": 1, "faculty_id": 1, "faculty_name": 1, "load_id": 1},
        ):
            if (a.get("user_id") not in ["", None]) or (a.get("faculty_id") not in ["", None]):
                return True
            if (a.get("faculty_name") or "").strip():
                return True
            if a.get("load_id") not in ["", None]:
                return True
        return False

    removable: List[Dict[str, Any]] = []
    for s in secs:
        sid = s["section_id"]
        if not await _has_real_schedule(sid) and not await _has_real_faculty(sid):
            removable.append(s)

    to_delete = min(cur_count - target_count, len(removable))
    deleted = 0
    for s in removable[:to_delete]:
        sid = s["section_id"]
        await db[COL_SECTIONS].delete_one({"section_id": sid})
        await db[COL_SCHEDS].delete_many({"section_id": sid})
        await db[COL_FAC_ASSIGN].update_many(
            {"section_id": sid},
            {"$set": {"is_archived": True, "updated_at": now()}},
        )
        deleted += 1
    return deleted


# ---------- planning snapshots & diffs ----------
# ---------- planning snapshots & diffs ----------
async def _preen_snapshot(term_id: str, campus_id: str) -> Dict[str, int]:
    """
    Snapshot of pre-enlistment counts keyed by course_id.

    Campus behavior:
    - If the preenlistment_count collection stores campus_id for this term, we STRICTLY scope to campus_id.
    - If the dataset is legacy (no campus_id stored at all for this term), we fall back to term-wide rows.
    """
    base_cond: Dict[str, Any] = {"term_id": term_id, "is_archived": {"$ne": True}}

    async def _scan(cond: Dict[str, Any]) -> Dict[str, int]:
        out: Dict[str, int] = {}
        async for d in db[COL_PREEN].find(cond, {"_id": 0, "course_id": 1, "preenlistment_count": 1, "count": 1}):
            cid = d.get("course_id") or ""
            out[cid] = out.get(cid, 0) + int(d.get("preenlistment_count") or d.get("count") or 0)
        return out

    campus_cond = {**base_cond, "campus_id": campus_id}
    out = await _scan(campus_cond)
    if out:
        return out

    # If there are *any* campus-tagged rows for this term, do NOT mix campuses.
    term_has_any_campus = await db[COL_PREEN].count_documents(
        {**base_cond, "campus_id": {"$exists": True, "$ne": ""}}
    ) > 0
    if term_has_any_campus:
        return {}

    # Legacy fallback: campus_id not stored
    return await _scan(base_cond)

async def _cohort_snapshot(term_id: str, campus_id: str) -> Dict[str, Dict[str, int]]:
    cur = db[COL_CURRICULUM].find({"term_id": term_id, "campus_id": campus_id}, {"_id": 0, "program_id": 1})
    rows = [x async for x in cur]
    pids = sorted(list({r["program_id"] for r in rows if r.get("program_id")}))
    out: Dict[str, Dict[str, int]] = {}
    for pid in pids:
        stats = await _program_stats_doc(term_id, pid) or {}
        out[pid] = {
            "freshman": int(stats.get("freshman") or 0),
            "sophomore": int(stats.get("sophomore") or 0),
            "junior": int(stats.get("junior") or 0),
            "senior": int(stats.get("senior") or 0),
        }
    return out

async def _planned_capacity_by_course_multi(term_id: str, prefix_map: Dict[str, str], course_ids: List[str]) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for cid in course_ids:
        sec_q: Dict[str, Any] = {
            "term_id": term_id,
            "status": {"$ne": "archived"},
            "$or": [{"course_id": cid}, {"fulfilled_placeholder_course_id": cid}],
        }
        pref = (prefix_map.get(cid) or "").strip()
        if pref:
            sec_q["section_code"] = {"$regex": f"^{pref}", "$options": "i"}
        total = 0
        async for s in db[COL_SECTIONS].find(sec_q, {"_id":0, "enrollment_cap":1}):
            total += int(s.get("enrollment_cap") or DEFAULT_CAP)
        out[cid] = total
    return out

async def _section_count(term_id: str, campus_prefix_pattern: str, course_id: str) -> int:
    q: Dict[str, Any] = {"term_id": term_id, "status": {"$ne": "archived"}}
    q["$or"] = [{"course_id": course_id}, {"fulfilled_placeholder_course_id": course_id}]
    if campus_prefix_pattern:
        q["section_code"] = {"$regex": f"^{campus_prefix_pattern}", "$options": "i"}
    return await db[COL_SECTIONS].count_documents(q)

async def _pending_changes(
    *, term_id: str, campus_id: str, campus_name: str
) -> Tuple[bool, List[Dict[str, Any]], str, str]:
    # IMPORTANT:
    # Keep Manila/Laguna truly independent.
    # If pre-enlistment rows are campus-scoped (campus_id stored for this term),
    # do NOT fall back to other campuses when this campus has no data yet.
    preen_base = {"term_id": term_id, "is_archived": {"$ne": True}}

    has_preen_campus = await db[COL_PREEN].count_documents({**preen_base, "campus_id": campus_id}) > 0
    if has_preen_campus:
        has_preen = True
    else:
        term_has_any_campus = await db[COL_PREEN].count_documents(
            {**preen_base, "campus_id": {"$exists": True, "$ne": ""}}
        ) > 0
        if term_has_any_campus:
            has_preen = False
        else:
            # Legacy dataset (no campus_id stored): use term-wide rows
            has_preen = await db[COL_PREEN].count_documents(preen_base) > 0

    # Program statistics are imported per program. To avoid "phantom readiness" caused by other campuses,
    # we consider stats "ready" only if this campus' curriculum programs have stats in this term.
    prog_ids = await db[COL_CURRICULUM].distinct("program_id", {"term_id": term_id, "campus_id": campus_id})
    prog_ids = [str(x).strip() for x in prog_ids if str(x).strip()]

    if prog_ids:
        prog_rows = [p async for p in db[COL_PROGRAMS].find(
            {"program_id": {"$in": prog_ids}},
            {"_id": 0, "program_id": 1, "program_code": 1},
        )]
        pid_to_code = {
            (p.get("program_id") or "").strip(): (p.get("program_code") or "").strip().upper()
            for p in prog_rows
        }
        codes = [c for c in pid_to_code.values() if c]

        stats_q: Dict[str, Any] = {"term_id": term_id, "$or": []}
        stats_q["$or"].append({"program_id": {"$in": prog_ids}})
        if codes:
            stats_q["$or"].append({"program_code": {"$in": codes}})

        present_pids: Set[str] = set()
        present_codes: Set[str] = set()
        async for d in db[COL_PREEN_STATS].find(stats_q, {"_id": 0, "program_id": 1, "program_code": 1}):
            if d.get("program_id"):
                present_pids.add(str(d.get("program_id")).strip())
            if d.get("program_code"):
                present_codes.add(str(d.get("program_code")).strip().upper())

        # require stats for every program in this campus curriculum
        has_stats = True
        for pid in prog_ids:
            code = pid_to_code.get(pid, "")
            if (pid not in present_pids) and (not code or code not in present_codes):
                has_stats = False
                break
    else:
        # If no curriculum exists, keep old behavior (term-wide presence)
        has_stats = await db[COL_PREEN_STATS].count_documents({"term_id": term_id}) > 0

    needs_import = not (has_preen and has_stats)

    preen_map = await _preen_snapshot(term_id, campus_id)
    cohort_map = await _cohort_snapshot(term_id, campus_id)
    preen_hash = _sha1_of(preen_map)
    cohort_hash = _sha1_of(cohort_map)

    if needs_import:
        return (True, [], preen_hash, cohort_hash)

    currs = [x async for x in db[COL_CURRICULUM].find(
        {"term_id": term_id, "campus_id": campus_id},
        {"_id": 0, "program_id": 1, "batch_id": 1, "term_id": 1, "course_list": 1}
    )]
    course_ids_in_curr = set()
    for c in currs:
        for cid in ensure_list(c.get("course_list")):
            if cid:
                course_ids_in_curr.add(cid)

    changes: List[Dict[str, Any]] = []
    for cid, cnt in preen_map.items():
        if cid and cnt > 0 and cid not in course_ids_in_curr:
            sample = await db[COL_PREEN].find_one({"term_id": term_id, "course_id": cid, "campus_id": campus_id}) \
                     or await db[COL_PREEN].find_one({"term_id": term_id, "course_id": cid})
            target = None
            if sample and sample.get("program_id") and sample.get("batch_id"):
                target = {"program_id": sample["program_id"], "batch_id": sample["batch_id"]}
            changes.append({
                "type": "add_course_to_curriculum",
                "course_id": cid,
                "count": cnt,
                "target": target,
            })

    view_course_ids = sorted(list(course_ids_in_curr))
    c_map_for_level = await map_courses(view_course_ids)

    prefix_map: Dict[str, str] = {}
    for cid in view_course_ids:
        lvl = c_map_for_level.get(cid, {}).get("program_level")
        prefix_map[cid] = prefix_pattern_for_level(campus_name, lvl) or ""

    demand_by_course: Dict[str, int] = {}
    for cid in view_course_ids:
        est = await estimated_demand(term_id, campus_id, cid)
        demand_by_course[cid] = est["plan"]
    cap_by_course = await _planned_capacity_by_course_multi(term_id, prefix_map, view_course_ids)

    course_to_programs: Dict[str, set] = {}
    for c in currs:
        pid = c.get("program_id")
        for cid in ensure_list(c.get("course_list")):
            if pid and cid:
                course_to_programs.setdefault(cid, set()).add(pid)
    base_by_course: Dict[str, int] = {cid: max(1, len(ps)) for cid, ps in course_to_programs.items()}

    for cid in view_course_ids:
        plan = int(demand_by_course.get(cid) or 0)
        existing = await _section_count(term_id, prefix_map.get(cid, ""), cid)
        base = int(base_by_course.get(cid, 1))
        eff_cap = await effective_section_capacity(term_id, campus_name, cid) or DEFAULT_CAP
        need_demand = max(1, ceil((plan or 0) / eff_cap))
        target = max(base, need_demand)

        if existing < target:
            add_by = target - existing
            changes.append({"type": "sections_increase", "course_id": cid, "by_sections": add_by})
        elif existing > target:
            changes.append({"type": "sections_decrease", "course_id": cid, "by_sections": existing - target})


    # Enrich pending changes with course_code/title so the UI can display codes
    # even when the course is not yet part of the term's curriculum/offering options.
    try:
        change_course_ids = sorted({c.get("course_id") for c in changes if c.get("course_id")})
        cmeta = await map_courses(change_course_ids)
        for ch in changes:
            cid = ch.get("course_id")
            meta = cmeta.get(cid) if cid else None
            if not meta:
                continue
            cc = meta.get("course_code")
            if isinstance(cc, list):
                cc = cc[0] if cc else ""
            ch.setdefault("course_code", cc or "")
            ch.setdefault("course_title", meta.get("course_title") or "")
    except Exception:
        # never block pending changes on metadata enrichment
        pass

    return (False, changes, preen_hash, cohort_hash)

async def _planning_flags(term_id: str, campus_id: str, campus_prefix: str):
    meta = await campus_meta(campus_id)
    needs_import, pending, preen_hash, cohort_hash = await _pending_changes(
        term_id=term_id, campus_id=campus_id, campus_name=meta.get("campus_name","")
    )

    plan_state = await db[COL_PLANSTATE].find_one({"term_id": term_id, "campus_id": campus_id}) or {}
    approved_flag = bool(plan_state.get("approved"))
    last_preen = plan_state.get("last_preen_hash")
    last_cohort = plan_state.get("last_cohort_hash")

    approval_required = (not needs_import) and (
        bool(pending)
        or (approved_flag is False)
        or (preen_hash != last_preen)
        or (cohort_hash != last_cohort)
    )
    return needs_import, approval_required, pending, preen_hash, cohort_hash, plan_state
# --- room availability helpers (capacity/type/time overlap) ---
# --- room availability helpers (capacity/type/time overlap) ---

# Reuse the same day aliases and time bands as Room Allocation,
# but keep them local to this file so we don't import from apo.py.

DAY_ALIASES: Dict[str, List[str]] = {
    "Monday": ["Monday", "M", "MON", "MONDAY"],
    "Tuesday": ["Tuesday", "T", "TU", "TUE", "TUESDAY"],
    "Wednesday": ["Wednesday", "W", "WED", "WEDNESDAY"],
    "Thursday": ["Thursday", "TH", "H", "R", "THU", "THUR", "THURS", "THURSDAY"],
    "Friday": ["Friday", "F", "FRI", "FRIDAY"],
    "Saturday": ["Saturday", "S", "SAT", "SATURDAY"],
}

TIME_BANDS = [
    "07:30 – 09:00",
    "09:15 – 10:45",
    "11:00 – 12:30",
    "12:45 – 14:15",
    "14:30 – 16:00",
    "16:15 – 17:45",
    "18:00 – 19:30",
]

DEFAULT_OPEN_DAYS_MANILA = ["Thursday", "Friday", "Saturday"]
DEFAULT_OPEN_DAYS_LAGUNA = ["Monday", "Tuesday", "Wednesday", "Saturday"]


def day_aliases(day_full: str) -> List[str]:
    """Return all code/name variants for a day: 'Monday' -> ['Monday','M','MON',...]"""
    return DAY_ALIASES.get(day_full, [day_full])


def default_open_days_for_campus(campus_name: str) -> List[str]:
    n = (campus_name or "").lower()
    # Laguna variants
    if "laguna" in n or "canlubang" in n or "biñan" in n or "binan" in n:
        return DEFAULT_OPEN_DAYS_LAGUNA
    # Default to Manila if not Laguna
    return DEFAULT_OPEN_DAYS_MANILA


def _t4(v: Any) -> Optional[str]:
    """Normalize time to 'HHMM' (e.g. '7:30' -> '0730')."""
    if v is None:
        return None
    s = "".join(ch for ch in str(v) if ch.isdigit())
    if len(s) == 0:
        return None
    if len(s) < 4:
        s = ("0000" + s)[-4:]
    return s[:4]


def fmt_pair(t: Any) -> str:
    """Format 'HHMM' -> 'HH:MM'; return '' if malformed."""
    s = _t4(t)
    if not s or len(s) != 4:
        return ""
    h, m = s[:2], s[2:]
    try:
        return f"{int(h):02d}:{m}"
    except Exception:
        return ""


def band_of(start: Any, end: Any) -> str:
    """Return 'HH:MM – HH:MM' or '' if either side is missing."""
    a, b = fmt_pair(start), fmt_pair(end)
    return f"{a} – {b}" if (a and b) else ""

def normalize_room_type(rt: Optional[str]) -> str:
    """Normalize physical room types.

    Returns '' for non-physical delivery modes (e.g., 'Online'), so callers can treat
    it as "no constraint".
    """
    u = (rt or "").strip().lower().replace(" ", "")
    if u in {"classroom", "class", "cr"}:
        return "Classroom"
    if u in {"comlab", "lab", "computerlab", "laboratory"}:
        return "ComLab"
    # delivery modes / not-a-room requirements
    if u in {"online", "onl", "virtual", "remote", "async", "asynch", "asynchronous",
             "sync", "synchronous", "hybrid", "blended", "tba", "na", "n/a", "none"}:
        return ""
    return (rt or "").strip()

async def _rooms_available_for_slot(
    campus_id: str,
    term_id: str,
    day: str,
    start: str,   # "HHMM"
    end: str,     # "HHMM"
    required_type: Optional[str] = None,
    min_capacity: Optional[int] = None,
    exclude_schedule_ids: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """
    Return rooms that:
      * belong to the given campus
      * match required_type (if provided)
      * match min_capacity EXACTLY (sections.enrollment_cap == rooms.capacity)
      * have this specific day + time slot allowed in Room Allocation
        (via section_schedules availability placeholders or campus defaults)
      * are not already booked by another section at an overlapping slot.
    """

    # --- normalize inputs ----------------------------------------------------
    day_full = normalize_day(day)  # this is already defined earlier in this file
    start4 = _t4(start)
    end4 = _t4(end)
    exclude_schedule_ids = exclude_schedule_ids or []

    if not (day_full and start4 and end4):
        return []

    # --- 1) Candidate rooms in campus, filtered by type + exact capacity ----
    room_q: Dict[str, Any] = {"campus_id": campus_id}
    if required_type:
        # section_schedules.room_type must match rooms.room_type
        room_q["room_type"] = required_type
    if min_capacity is not None:
        # EXACT equality: sections.enrollment_cap == rooms.capacity
        room_q["capacity"] = {"$gte": min_capacity}

    rooms: List[Dict[str, Any]] = [
        r async for r in db[COL_ROOMS].find(
            room_q,
            {
                "_id": 0,
                "room_id": 1,
                "room_number": 1,
                "room_type": 1,
                "capacity": 1,
                "building": 1,
                "campus_id": 1,
                "status": 1,
            },
        )
    ]
    if not rooms:
        return []

    room_ids = [r["room_id"] for r in rooms]

    # --- 2) Availability placeholders for these rooms on this *day* ---------
    # These are the AVAIL-* rows from Room Allocation:
    #   section_id is ABSENT -> "this slot is open for this room".
    from collections import defaultdict
    avail_pairs_by_room: Dict[str, Set[Tuple[str, str]]] = defaultdict(set)

    avail_cur = db[COL_SCHEDS].find(
        {
            "room_id": {"$in": room_ids},
            "section_id": {"$exists": False},              # availability rows only
            "day": {"$in": day_aliases(day_full)},         # M / MON / Monday, etc.
        },
        {"_id": 0, "room_id": 1, "start_time": 1, "end_time": 1},
    )

    async for a in avail_cur:
        rid = a.get("room_id")
        if not rid:
            continue
        st = _t4(a.get("start_time"))
        et = _t4(a.get("end_time"))
        if not (st and et):
            continue
        # Each pair represents one available band for this day
        avail_pairs_by_room[rid].add((st, et))

    # Campus default open days (same logic as Room Allocation grid)
    campus = await campus_meta(campus_id)
    default_days = default_open_days_for_campus(campus.get("campus_name", ""))

    # Convert our start/end into the canonical band string ("07:30 – 09:00")
    band_str = band_of(start4, end4)
    band_is_standard = band_str in TIME_BANDS

    # Decide which rooms are allowed *by availability rules*
    allowed_room_ids: Set[str] = set()
    for rid in room_ids:
        pairs_for_day = avail_pairs_by_room.get(rid)

        if pairs_for_day:
            # Room has explicit availability rows for this day:
            # only allow if this exact (start,end) pair exists.
            if (start4, end4) in pairs_for_day:
                allowed_room_ids.add(rid)
        else:
            # No explicit availability rows for this day:
            # fall back to campus default open days (and only for standard bands).
            if day_full in default_days and band_is_standard:
                allowed_room_ids.add(rid)

    if not allowed_room_ids:
        return []

    # Narrow candidate rooms to those that pass the availability check
    rooms = [r for r in rooms if r["room_id"] in allowed_room_ids]
    if not rooms:
        return []

    allowed_ids = [r["room_id"] for r in rooms]

    # --- 3) BUSY FILTER: exclude rooms already booked in this slot (TERM-AWARE) ---
    # A room is BUSY only if the overlapping schedule belongs to a section in the SAME planning term.

    sched_q: Dict[str, Any] = {
        "room_id": {"$in": allowed_ids},
        "section_id": {"$exists": True},
        "day": {"$in": day_aliases(day_full)},
    }
    if exclude_schedule_ids:
        sched_q["schedule_id"] = {"$nin": exclude_schedule_ids}

    overlaps: List[Tuple[str, str]] = []  # (room_id, section_id)
    async for s in db[COL_SCHEDS].find(
        sched_q,
        {"_id": 0, "room_id": 1, "section_id": 1, "start_time": 1, "end_time": 1},
    ):
        rid = (s.get("room_id") or "").strip()
        sid = (s.get("section_id") or "").strip()
        if not (rid and sid):
            continue
        st0 = _t4(s.get("start_time"))
        et0 = _t4(s.get("end_time"))
        if not (st0 and et0):
            continue
        # overlap: [st0,et0) intersects [start4,end4)
        if int(st0) < int(end4) and int(et0) > int(start4):
            overlaps.append((rid, sid))

    busy_room_ids: Set[str] = set()
    if overlaps:
        sec_ids = sorted({sid for _, sid in overlaps})
        same_term_ids: Set[str] = set()
        async for x in db[COL_SECTIONS].find(
            {"section_id": {"$in": sec_ids}, "term_id": term_id},
            {"_id": 0, "section_id": 1},
        ):
            sid = (x.get("section_id") or "").strip()
            if sid:
                same_term_ids.add(sid)
        busy_room_ids = {rid for (rid, sid) in overlaps if sid in same_term_ids}

# --- 4) Final list: available-by-timeslot AND not busy -------------------
    return [r for r in rooms if r["room_id"] not in busy_room_ids]

# ---------- GET ----------
@router.get("/courseofferings")
async def get_course_offerings(
    userId: str = Query(..., min_length=3),
    level: Optional[str] = Query(None),
    department_id: Optional[str] = Query(None),
    batch_id: Optional[str] = Query(None),
    program_id: Optional[str] = Query(None),
    view: Optional[Literal["curriculum", "offerings", "specialclass"]] = Query("offerings"),
    action: Optional[str] = Query(None),

    # room filtering params
    day: Optional[str] = Query(None),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    room_type: Optional[str] = Query(None),
    capacity: Optional[int] = Query(None),
    exclude: Optional[str] = Query(None),
    section_id: Optional[str] = Query(None),
    course_id: Optional[str] = Query(None),
    slot: Optional[int] = Query(None),              
    schedule_id: Optional[str] = Query(None),      
    # NEW: used only when action == "catalogSearch"
    q: Optional[str] = Query(None),
    limit: int = Query(20),
):

    # Use PLANNING term (next term after is_current), same as Preenlistment
    planning_term = await _get_planning_term()
    term_id = (planning_term or {}).get("term_id")

    if not term_id:
        return {
            "campus": {"campus_id": "", "campus_name": ""},
            "term_id": "", "term_label": "",
            "filters": {"levels": [], "departments": [], "ids": [], "programs": []},
            "rows": [], "course_options_by_group": {}, "room_options": [],
            "planning": {"needs_import": True, "approval_required": False}
        }

    # Mark sections “active” for the PLANNING term, others “inactive”
    await _sync_section_status_flags(term_id)

    campus_id, _ = await apo_scope(userId)
    if not campus_id:
        raise HTTPException(status_code=400, detail="Unable to resolve APO campus from role_assignments.")
    campus = await campus_meta(campus_id)
    prefix_default = campus_section_prefix(campus.get("campus_name", "")) or ""

    # OM submission deadline window (set by APO per campus + planning term)
    om_submit_window = await _get_om_submit_window(term_id, campus_id)


    # Lightweight fetch for pages that only need campus/term/deadline metadata (e.g., Inbox topbar label)
    if action == "meta":
        return {
            "ok": True,
            "campus": campus,
            "term_id": term_id,
            "term_label": term_label(planning_term),
            "om_submit_window": om_submit_window,
        }
    # ---- filtered room options for a given slot (frontend can call this) ----
    if action == "roomOptions":
        # Delegate to eligibleRooms to keep a single source of truth
        # (section_id/course_id are already in the function signature)
        return await get_course_offerings(
            userId=userId, level=level, department_id=department_id, batch_id=batch_id,
            program_id=program_id, view=view, action="eligibleRooms",
            day=day, start=start, end=end, room_type=room_type, capacity=capacity,
            exclude=exclude, section_id=section_id, course_id=course_id
        )
    
    if action == "eligibleRooms":
        # --- parse incoming
        exclude_ids = [x for x in (exclude or "").split(",") if x]
        if schedule_id and schedule_id not in exclude_ids:
            exclude_ids.append(schedule_id)

        # If the caller did not provide section_id (common in Special Class), but did provide
        # a schedule_id, infer section_id (and default day/start/end/room_type) from the schedule.
        # This allows the endpoint to still filter by enrollment_cap/room_type correctly.
        if (not section_id) and schedule_id:
            sch_ctx = await db[COL_SCHEDS].find_one(
                {"schedule_id": schedule_id},
                {"_id": 0, "section_id": 1, "day": 1, "start_time": 1, "end_time": 1, "room_type": 1},
            )
            if sch_ctx and sch_ctx.get("section_id"):
                section_id = str(sch_ctx.get("section_id") or "").strip() or section_id
                if not day:
                    day = sch_ctx.get("day")
                if not start:
                    start = sch_ctx.get("start_time")
                if not end:
                    end = sch_ctx.get("end_time")
                if not room_type:
                    room_type = sch_ctx.get("room_type")
        # pull section context when available
        sec_doc = None
        if section_id:
            sec_doc = await db[COL_SECTIONS].find_one(
                {"section_id": section_id},
                {"_id": 0, "campus_id": 1, "course_id": 1}
            )

        # prefer the section’s campus for room lookup; fallback to APO campus
        campus_for_rooms = (sec_doc or {}).get("campus_id") or campus_id

        # which course to use for defaults (capacity/room_type)
        cid_for_defaults = (course_id or (sec_doc or {}).get("course_id") or "").strip() or None

        # normalize day/time if they were provided
        day_n   = normalize_day((day or "").strip())
        start_n = "".join(ch for ch in (start or "") if ch.isdigit())
        end_n   = "".join(ch for ch in (end or "") if ch.isdigit())

        # --- try to infer the slot (day/time and room_type) from DB when day/start/end are missing
        slots: List[Tuple[str, str, str, Optional[str]]] = []
        if not (day_n and start_n and end_n) and section_id:
            # prioritize an explicit schedule_id or one inside exclude (e.g., SCH0614-01)
            target_sched_ids: List[str] = []
            if schedule_id:
                target_sched_ids.append(schedule_id)
            target_sched_ids += [x for x in exclude_ids if x.startswith("SCH")]

            scheds = [x async for x in db[COL_SCHEDS].find(
                {"section_id": section_id},
                {"_id": 0, "schedule_id": 1, "day": 1, "start_time": 1, "end_time": 1, "room_type": 1}
            )]

            def _t4(v: Any) -> str:
                return "".join(ch for ch in str(v or "") if ch.isdigit())

            picked = None
            # try the schedule being edited first
            for sid_try in target_sched_ids:
                for s in scheds:
                    if s.get("schedule_id") == sid_try and s.get("day") and s.get("start_time") and s.get("end_time"):
                        picked = s
                        break
                if picked:
                    break

            if picked:
                slots = [(normalize_day(picked.get("day")), _t4(picked.get("start_time")), _t4(picked.get("end_time")), picked.get("room_type"))]
            else:
                # else: use every schedule that already has time info
                for s in scheds:
                    if s.get("day") and s.get("start_time") and s.get("end_time"):
                        slots.append((normalize_day(s.get("day")), _t4(s.get("start_time")), _t4(s.get("end_time")), s.get("room_type")))

        # if the query actually had a time, use that as the single slot
        if day_n and start_n and end_n:
            slots = [(day_n, start_n, end_n, None)]

        # still no time? no rooms to compute availability for
        if not slots:
            return {"ok": True, "rooms": []}

        # --- capacity resolution (min capacity filter)
        cap_n: Optional[int] = None
        if capacity not in (None, "", "null"):
            try:
                cap_n = int(capacity)
            except Exception:
                cap_n = None
        if cap_n is None and section_id:
            sec_cap = await db[COL_SECTIONS].find_one(
                {"section_id": section_id}, {"_id": 0, "enrollment_cap": 1}
            )
            try:
                cap_n = int((sec_cap or {}).get("enrollment_cap"))
            except Exception:
                cap_n = None
        if cap_n is None and cid_for_defaults:
            try:
                cap_n = int(await default_capacity_for_course(cid_for_defaults))
            except Exception:
                cap_n = None

        # --- required room_type (explicit > schedule’s type > course’s type)
        rt_required = normalize_room_type((room_type or "").strip()) or None
        if not rt_required:
            # prefer the picked schedule’s room_type if we have exactly one slot
            if len(slots) == 1 and slots[0][3]:
                rt_required = normalize_room_type(slots[0][3]) or None
            elif cid_for_defaults:
                cdoc = await db[COL_COURSES].find_one({"course_id": cid_for_defaults}, {"_id": 0, "room_type": 1})
                rt_required = ((cdoc or {}).get("room_type") or "").strip() or None

        # --- compute available rooms for each inferred slot; union the results
        slot_room_sets: List[Dict[str, Dict[str, Any]]] = []
        for (d, s, e, _rt_from_sched) in slots:
            avail = await _rooms_available_for_slot(
                campus_id=campus_for_rooms,
                term_id=term_id,
                day=d,
                start=s,
                end=e,
                required_type=rt_required,
                min_capacity=cap_n,
                exclude_schedule_ids=exclude_ids,
            )
            slot_room_sets.append({r["room_id"]: r for r in avail})

        if not slot_room_sets:
            return {"ok": True, "rooms": []}

        # If we know the exact slot (because `schedule_id` OR explicit day/time were provided),
        # use that single slot’s result. Otherwise, don’t over-restrict: use the UNION.
        if len(slots) == 1:
            chosen_map = slot_room_sets[0]
            ids = set(chosen_map.keys())
        else:
            ids = set()
            for m in slot_room_sets:
                ids |= set(m.keys())
            # prefer the first map just for pulling room objects
            chosen_map = slot_room_sets[0]

        rooms = sorted(
            [chosen_map[rid] for rid in ids],
            key=lambda x: (str(x.get("building") or ""), str(x.get("room_number") or "")),
        )
        return {"ok": True, "rooms": rooms}

    if action == "electiveOptions":
        options = await _fetch_all_specific_electives_async()
        return {"ok": True, "options": options}

    # ---- Curriculum View ----
    if view == "curriculum":
        curr = [x async for x in db[COL_CURRICULUM].find(
            {"term_id": term_id, "campus_id": campus_id},
            {"_id": 0, "curriculum_id": 1, "program_id": 1, "batch_id": 1, "term_id": 1, "course_list": 1}
        )]
        batch_by_number, batch_by_id = await map_batches()
        prog_ids = sorted(list({c["program_id"] for c in curr if c.get("program_id")}))
        prog_map = await map_programs(prog_ids)
        dep_ids = sorted(list({
            (prog_map.get(p) or {}).get("department_id","")
            for p in prog_ids if (prog_map.get(p) or {}).get("department_id")
        }))
        dep_map = await map_departments(dep_ids)

        all_cids = sorted(list({cid for r in curr for cid in ensure_list(r.get("course_list"))}))
        cinfo = await map_courses(all_cids)

        items: List[Dict[str, Any]] = []
        for r in curr:
            pid = r.get("program_id", ""); bid = r.get("batch_id", "")
            b = batch_by_id.get(bid, {}); p = prog_map.get(pid, {})
            dep_id = p.get("department_id", "")
            courses: List[Dict[str, Any]] = []
            for cid in ensure_list(r.get("course_list")):
                ci = cinfo.get(cid, {})
                courses.append({
                    "course_id": cid,
                    "code": ci.get("course_code",""),
                    "title": ci.get("course_title",""),
                    "units": ci.get("units"),
                    "department_id": ci.get("department_id",""),
                    "department_name": dep_map.get(ci.get("department_id",""),{}).get("department_name",""),
                    "program_level": ci.get("program_level_label",""),
                    "program_level_code": ci.get("program_level",""),
                })
            items.append({
                "program_id": pid, "program_code": p.get("program_code",""),
                "department_id": dep_id, "department_name": dep_map.get(dep_id,{}).get("department_name",""),
                "batch_id": bid, "batch_code": _norm_code(b.get("batch_code")),
                "courses": courses,
            })

        by_dep: Dict[str, List[Dict[str, Any]]] = {}
        async for cc in db[COL_COURSES].find(
            {"department_id": {"$in": dep_ids}},
            {"_id":0,"course_id":1,"course_code":1,"course_title":1,"department_id":1,"program_level":1,"units":1,"type_of_course":1}
        ):
            code = cc.get("course_code")
            if isinstance(code, list):
                code = code[0] if code else ""
            by_dep.setdefault(cc["department_id"], []).append({
                "course_id": cc["course_id"],
                "course_code": code or "",
                "course_title": cc.get("course_title",""),
                "department_id": cc["department_id"],
                "program_level": level_label(cc.get("program_level")),
                "program_level_code": cc.get("program_level"),
                "units": cc.get("units"),
                "type_of_course": cc.get("type_of_course","") or None,
            })
        course_options_by_program: Dict[str, List[Dict[str, Any]]] = {}
        for pid, p in prog_map.items():
            dep_id = p.get("department_id","")
            opts = sorted(by_dep.get(dep_id, []), key=lambda x: x["course_code"])
            course_options_by_program[pid] = opts

        departments = [{"department_id": d, "department_name": dep_map.get(d,{}).get("department_name","")} for d in dep_ids]
        
        # Submission state (for UI: decide whether re-submission must include a comment)
        sub_doc = await db[COL_APO_SUBMISSIONS].find_one(
            {"term_id": term_id, "campus_id": campus_id},
            {"_id": 0, "submit_count": 1, "first_submitted_at": 1, "last_submitted_at": 1, "last_submitted_by": 1},
        ) or {}

        has_prior_submit = int(sub_doc.get("submit_count") or 0) > 0

        # Fallback for older data: if no submissions record exists yet, check if any section was ever submitted
        if not has_prior_submit:
            prior = await db[COL_SECTIONS].find_one(
                {"term_id": term_id, "campus_id": campus_id, "submitted_for_scheduling": True},
                {"_id": 0, "section_id": 1},
            )
            has_prior_submit = bool(prior)

        submission = {
            "has_prior_submit": has_prior_submit,
            "submit_count": int(sub_doc.get("submit_count") or (1 if has_prior_submit else 0)),
            "first_submitted_at": sub_doc.get("first_submitted_at"),
            "last_submitted_at": sub_doc.get("last_submitted_at"),
            "last_submitted_by": sub_doc.get("last_submitted_by"),
        }

        return {
            "campus": campus,
            "term_id": term_id,
            "term_label": term_label(planning_term),
            "om_submit_window": om_submit_window,
            "submission": submission, 
            "items": items,
            "course_options_by_program": course_options_by_program,
            "departments": departments
        }
    
    # ---------- SPECIAL CLASS (APO view) ----------
    async def _active_term_for_specialclass() -> Dict[str, Any]:
        # Align Special Class with APO planning term (same as Room Allocation / Offerings).
        # Fallback to current term only if planning term cannot be resolved.
        return await _get_planning_term() or (await _ensure_current_term() or {})


    async def _specialclass_rows(term_id: str, filters: Dict[str, Any]) -> List[Dict[str, Any]]:
        filters = filters or {}

        # Pull rows; exclude Mongo _id so we don't need ObjectId conversion
        rows = [x async for x in db[COL_SPECIAL].find({"term_id": term_id, **filters}, {"_id": 0})]
        if not rows:
            return []

        def _s(x: Any) -> str:
            return (str(x).strip() if x is not None else "")

        def _course_code_str(cc: Any) -> str:
            if isinstance(cc, list):
                return _s(cc[0]) if cc else ""
            return _s(cc)

        DAY_ORDER = {"M": 1, "T": 2, "W": 3, "H": 4, "F": 5, "S": 6}

        def _hhmm(x: Any) -> str:
            if x is None:
                return ""
            s = _s(x)
            s = re.sub(r"[^\d]", "", s)
            return s.zfill(4) if s else ""

        def _fmt_time(hhmm: str) -> str:
            hhmm = _hhmm(hhmm)
            return f"{hhmm[:2]}:{hhmm[2:]}" if len(hhmm) == 4 else ""

        # Collect IDs for bulk mapping
        program_ids = sorted({_s(r.get("program_id")) for r in rows if _s(r.get("program_id"))})
        department_ids = sorted({_s(r.get("department_id")) for r in rows if _s(r.get("department_id"))})
        course_ids = sorted({_s(r.get("course_id")) for r in rows if _s(r.get("course_id"))})

        # assignment_id -> (section_id, faculty_id)
        asg_ids = sorted({_s(r.get("assignment_id")) for r in rows if _s(r.get("assignment_id"))})
        asg_map: Dict[str, Dict[str, str]] = {}
        faculty_ids: set[str] = set()

        if asg_ids:
            async for a in db[COL_FAC_ASSIGN].find(
                {"assignment_id": {"$in": asg_ids}, "is_archived": {"$ne": True}},
                {"_id": 0, "assignment_id": 1, "section_id": 1, "faculty_id": 1},
            ):
                asg_id = _s(a.get("assignment_id"))
                sec_id = _s(a.get("section_id"))
                fac_id = _s(a.get("faculty_id"))
                asg_map[asg_id] = {"section_id": sec_id, "faculty_id": fac_id}
                if fac_id:
                    faculty_ids.add(fac_id)

        # faculty_id -> faculty_profile (and gather linked user_ids)
        fac_profile_map: Dict[str, Dict[str, Any]] = {}
        fac_user_ids: set[str] = set()

        if faculty_ids:
            async for fp in db[COL_FAC_PROFILES].find(
                {"faculty_id": {"$in": sorted(faculty_ids)}},
                {"_id": 0, "faculty_id": 1, "user_id": 1, "first_name": 1, "last_name": 1, "middle_name": 1},
            ):
                fid = _s(fp.get("faculty_id"))
                fac_profile_map[fid] = fp
                uid = _s(fp.get("user_id"))
                if uid:
                    fac_user_ids.add(uid)

        # students user_ids from rows
        student_user_ids = sorted({_s(r.get("user_id")) for r in rows if _s(r.get("user_id"))})

        # users (students + faculty linked)
        all_user_ids = sorted(set(student_user_ids) | set(fac_user_ids))
        user_map: Dict[str, Dict[str, Any]] = {}

        if all_user_ids:
            async for u in db[COL_USERS].find(
                {"user_id": {"$in": all_user_ids}},
                {"_id": 0, "user_id": 1, "first_name": 1, "last_name": 1, "middle_name": 1},
            ):
                user_map[_s(u.get("user_id"))] = u

        # programs
        prog_map: Dict[str, str] = {}
        if program_ids:
            async for p in db[COL_PROGRAMS].find(
                {"program_id": {"$in": program_ids}},
                {"_id": 0, "program_id": 1, "program_name": 1},
            ):
                prog_map[_s(p.get("program_id"))] = _s(p.get("program_name"))

        # departments
        dep_map: Dict[str, str] = {}
        if department_ids:
            async for d in db[COL_DEPARTMENTS].find(
                {"department_id": {"$in": department_ids}},
                {"_id": 0, "department_id": 1, "department_name": 1, "dept_name": 1},
            ):
                dep_map[_s(d.get("department_id"))] = _s(d.get("department_name")) or _s(d.get("dept_name"))

        # courses
        course_map: Dict[str, Dict[str, str]] = {}
        if course_ids:
            async for c in db[COL_COURSES].find(
                {"course_id": {"$in": course_ids}},
                {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1},
            ):
                cid = _s(c.get("course_id"))
                course_map[cid] = {
                    "course_code": _course_code_str(c.get("course_code")),
                    "course_title": _s(c.get("course_title")),
                }

        def _resolve_section_id(r: Dict[str, Any]) -> str:
            sid = _s(r.get("section_id"))
            if sid:
                return sid
            asg_id = _s(r.get("assignment_id"))
            if asg_id:
                return _s((asg_map.get(asg_id) or {}).get("section_id"))
            return ""

        def _resolve_faculty_id(r: Dict[str, Any]) -> str:
            asg_id = _s(r.get("assignment_id"))
            if asg_id:
                return _s((asg_map.get(asg_id) or {}).get("faculty_id"))
            return ""

        # Collect section_ids from either row.section_id OR assignment.section_id
        # Special classes may reference sections that are not in the curriculum / not in the regular offerings.
        # Some records store only section_code (or have an assignment_id); so we do a best-effort lookup by section_code.
        raw_missing_codes: set[str] = set()
        raw_missing_code_course: set[tuple[str, str]] = set()

        for r in rows:
            sid0 = _resolve_section_id(r)
            if sid0:
                continue
            scode = _s(r.get("section_code"))
            if not scode and isinstance(r.get("section"), dict):
                scode = _s(r.get("section", {}).get("section_code"))
            if not scode:
                continue
            cid0 = _s(r.get("course_id"))
            raw_missing_codes.add(scode)
            if cid0:
                raw_missing_code_course.add((scode, cid0))

        sec_by_code_only: Dict[str, str] = {}
        sec_by_code_course: Dict[tuple[str, str], str] = {}

        if raw_missing_codes:
            async for s in db[COL_SECTIONS].find(
                {"term_id": term_id, "section_code": {"$in": sorted(raw_missing_codes)}},
                {"_id": 0, "section_id": 1, "section_code": 1, "course_id": 1},
            ):
                sid = _s(s.get("section_id"))
                sc = _s(s.get("section_code"))
                ccid = _s(s.get("course_id"))
                if sid and sc:
                    sec_by_code_only.setdefault(sc, sid)
                    if ccid:
                        sec_by_code_course[(sc, ccid)] = sid


        # Also resolve missing section_id via schedule_id (if special_class stores schedule_entries/slots)
        raw_missing_sched_ids: set[str] = set()
        for r in rows:
            if _resolve_section_id(r):
                continue
            se0 = r.get("schedule_entries")
            if isinstance(se0, list):
                for e in se0[:2]:
                    if isinstance(e, dict):
                        sid = _s(e.get("schedule_id"))
                        if sid:
                            raw_missing_sched_ids.add(sid)
            for k in ("slot1", "slot2"):
                e = r.get(k)
                if isinstance(e, dict):
                    sid = _s(e.get("schedule_id"))
                    if sid:
                        raw_missing_sched_ids.add(sid)

        sec_by_sched_id: Dict[str, str] = {}
        if raw_missing_sched_ids:
            async for sch in db[COL_SCHEDS].find(
                {"schedule_id": {"$in": sorted(raw_missing_sched_ids)}},
                {"_id": 0, "schedule_id": 1, "section_id": 1},
            ):
                sid = _s(sch.get("schedule_id"))
                secid = _s(sch.get("section_id"))
                if sid and secid:
                    sec_by_sched_id[sid] = secid

        def _resolve_section_id_best(r: Dict[str, Any]) -> str:
            sid = _resolve_section_id(r)
            if sid:
                return sid

            # Fallback 1: derive section_id via schedule_id stored in this special_class row
            se0 = r.get("schedule_entries")
            if isinstance(se0, list):
                for e in se0[:2]:
                    if isinstance(e, dict):
                        sid2 = _s(e.get("schedule_id"))
                        if sid2 and sid2 in sec_by_sched_id:
                            return sec_by_sched_id[sid2]
            for k in ("slot1", "slot2"):
                e = r.get(k)
                if isinstance(e, dict):
                    sid2 = _s(e.get("schedule_id"))
                    if sid2 and sid2 in sec_by_sched_id:
                        return sec_by_sched_id[sid2]

            # Fallback 2: lookup by section_code (optionally course_id)
            scode = _s(r.get("section_code"))
            if not scode and isinstance(r.get("section"), dict):
                scode = _s(r.get("section", {}).get("section_code"))
            if scode:
                cid = _s(r.get("course_id"))
                if cid and (scode, cid) in sec_by_code_course:
                    return sec_by_code_course[(scode, cid)]
                if scode in sec_by_code_only:
                    return sec_by_code_only.get(scode, "")

            return ""

        section_ids: set[str] = set()
        for r in rows:
            sid = _resolve_section_id_best(r)
            if sid:
                section_ids.add(sid)

        # section_id -> section_code + remarks + enrollment_cap + OM approval flags
        sec_map: Dict[str, str] = {}
        sec_remarks_map: Dict[str, str] = {}
        sec_cap_map: Dict[str, int] = {}
        sec_om_approved_map: Dict[str, bool] = {}
        sec_room_ready_map: Dict[str, bool] = {}

        if section_ids:
            async for s in db[COL_SECTIONS].find(
                {"section_id": {"$in": sorted(section_ids)}},
                {
                    "_id": 0,
                    "section_id": 1,
                    "section_code": 1,
                    "remarks": 1,
                    "enrollment_cap": 1,
                    "om_approved": 1,
                    "room_allocation_ready": 1,
                },
            ):
                sid0 = _s(s.get("section_id"))
                sec_map[sid0] = _s(s.get("section_code"))
                sec_remarks_map[sid0] = _s(s.get("remarks"))
                sec_om_approved_map[sid0] = bool(s.get("om_approved"))
                sec_room_ready_map[sid0] = bool(s.get("room_allocation_ready"))
                try:
                    v = s.get("enrollment_cap")
                    cap = int(v) if v not in (None, "") else 0
                except Exception:
                    cap = 0
                if cap > 0:
                    sec_cap_map[sid0] = cap

        # section schedules + collect room_ids
        room_ids: set[str] = set()
        sched_by_section: Dict[str, List[Dict[str, Any]]] = {sid: [] for sid in section_ids}

        # Also fetch schedule documents by schedule_id (not just by section_id).
        # This is critical for Special Class rows whose course/section is NOT offered in the term
        # (or cannot be resolved cleanly), but their schedule_id still points to a real schedule row
        # where room_id is stored.
        sched_ids_needed: set[str] = set()
        for r in rows:
            se0 = r.get("schedule_entries")
            if isinstance(se0, list):
                for e in se0[:2]:
                    if isinstance(e, dict):
                        sid0 = _s(e.get("schedule_id"))
                        if sid0:
                            sched_ids_needed.add(sid0)
            for k in ("slot1", "slot2"):
                e = r.get(k)
                if isinstance(e, dict):
                    sid0 = _s(e.get("schedule_id"))
                    if sid0:
                        sched_ids_needed.add(sid0)

        sched_by_id: Dict[str, Dict[str, Any]] = {}
        if sched_ids_needed:
            async for sch in db[COL_SCHEDS].find(
                {"schedule_id": {"$in": sorted(sched_ids_needed)}},
                {
                    "_id": 0,
                    "schedule_id": 1,
                    "section_id": 1,
                    "day": 1,
                    "start_time": 1,
                    "end_time": 1,
                    "room_id": 1,
                    "room_type": 1,
                },
            ):
                sid0 = _s(sch.get("schedule_id"))
                if not sid0:
                    continue
                sched_by_id[sid0] = sch
                rid0 = _s(sch.get("room_id"))
                if rid0:
                    room_ids.add(rid0)

        if section_ids:
            async for sch in db[COL_SCHEDS].find(
                {"section_id": {"$in": sorted(section_ids)}},
                {"_id": 0, "schedule_id": 1, "section_id": 1, "day": 1, "start_time": 1, "end_time": 1, "room_id": 1, "room_type": 1},
            ):
                sid = _s(sch.get("section_id"))
                if not sid:
                    continue
                rid = _s(sch.get("room_id"))
                if rid:
                    room_ids.add(rid)
                sched_by_section.setdefault(sid, []).append(sch)

        # Also include room_ids already stored on special_class records (schedule_entries/slot1/slot2)
        # so we can display room_number even if the section has no matching schedules in this query.
        for r in rows:
            se0 = r.get("schedule_entries")
            if isinstance(se0, list):
                for e in se0[:2]:
                    if isinstance(e, dict):
                        rid = _s(e.get("room_id"))
                        if rid:
                            room_ids.add(rid)
            for k in ("slot1", "slot2"):
                e = r.get(k)
                if isinstance(e, dict):
                    rid = _s(e.get("room_id"))
                    if rid:
                        room_ids.add(rid)

        # room_id -> room_number (or room_name)
        room_map: Dict[str, str] = {}
        if room_ids:
            async for rm in db[COL_ROOMS].find(
                {"room_id": {"$in": sorted(room_ids)}},
                {"_id": 0, "room_id": 1, "room_number": 1, "room_name": 1},
            ):
                rid = _s(rm.get("room_id"))
                room_map[rid] = _s(rm.get("room_number")) or _s(rm.get("room_name"))

        def _slot_room_number(room_id: str, room_type: str) -> Any:
            rn = room_map.get(room_id)
            if rn:
                return rn

            # Treat ONLINE as "no physical room". If a physical room_id exists, display it even
            # if room_type was (incorrectly) stored as "Online" (delivery mode).
            if room_id.upper() == "ONLINE":
                return "TBA"

            if room_id:
                return room_id  # fallback if room not found in rooms collection

            return "TBA"

        def _slot_from_sched(s: Dict[str, Any]) -> Dict[str, Any]:
            rid = _s(s.get("room_id"))
            rt = _s(s.get("room_type"))

            # Keep a physical room_id even if room_type is "Online" (delivery mode).
            if rid.upper() == "ONLINE":
                rid = ""
            if rt.upper() == "ONLINE":
                rt = ""

            return {
                "schedule_id": _s(s.get("schedule_id")) or None,
                "day": _s(s.get("day")) or None,
                "start_time": _hhmm(s.get("start_time")) or None,
                "end_time": _hhmm(s.get("end_time")) or None,
                "room_id": rid or None,
                "room_type": rt or None,
                "room_number": _slot_room_number(rid, rt),
            }

        def _normalize_entry(e: Dict[str, Any]) -> Dict[str, Any]:
            # Prefer canonical schedule doc (from section_schedules) when schedule_id is present.
            sid0 = _s(e.get("schedule_id"))
            src = sched_by_id.get(sid0) if sid0 else None

            day0 = _s((src or {}).get("day") or e.get("day"))
            st0 = _hhmm((src or {}).get("start_time") or e.get("start_time"))
            et0 = _hhmm((src or {}).get("end_time") or e.get("end_time"))
            rid = _s((src or {}).get("room_id") or e.get("room_id"))
            rt = _s((src or {}).get("room_type") or e.get("room_type"))

            # ONLINE should render as TBA
            # Keep a physical room_id even if room_type is "Online" (delivery mode).
            if rid.upper() == "ONLINE":
                rid = ""
            if rt.upper() == "ONLINE":
                rt = ""

            room_number = _s(e.get("room_number"))
            if not room_number:
                room_number = _slot_room_number(rid, rt)

            return {
                "schedule_id": sid0 or None,
                "day": day0 or None,
                "start_time": st0 or None,
                "end_time": et0 or None,
                "room_id": rid or None,
                "room_type": rt or None,
                "room_number": room_number,
            }

        def _schedule_text(entries: List[Dict[str, Any]]) -> str:
            parts: List[str] = []
            for e in entries[:2]:
                if not isinstance(e, dict):
                    continue
                d = _s(e.get("day"))
                st = _hhmm(e.get("start_time"))
                et = _hhmm(e.get("end_time"))
                rn = _s(e.get("room_number"))
                time_part = ""
                if st and et:
                    time_part = f"{_fmt_time(st)}-{_fmt_time(et)}"
                seg = " ".join([x for x in [d, time_part, rn] if x])
                if seg:
                    parts.append(seg)
            return " / ".join(parts)

        # Fill computed fields
        for r in rows:
            pid = _s(r.get("program_id"))
            did = _s(r.get("department_id"))
            cid = _s(r.get("course_id"))
            suid = _s(r.get("user_id"))

            sid = _resolve_section_id_best(r)
            if sid:
                r["section_id"] = sid  # make it explicit/consistent
                if not _s(r.get("section_code")):
                    r["section_code"] = sec_map.get(sid, "")
                if "section_remarks" not in r:
                    r["section_remarks"] = sec_remarks_map.get(sid, "")

                # OM approval / room readiness flags
                r["om_approved"] = bool(sec_om_approved_map.get(sid, False))
                r["room_allocation_ready"] = bool(sec_room_ready_map.get(sid, False))

            # Provide a consistent min_capacity/capacity value for the frontend's EligibleRoomSelect.
            # This keeps Special Class room filtering consistent with Room Allocation.
            cap0 = sec_cap_map.get(sid or "", 0)
            if cap0 > 0:
                if r.get("min_capacity") in (None, "", 0):
                    r["min_capacity"] = cap0
                if r.get("capacity") in (None, "", 0):
                    r["capacity"] = cap0

            # schedule_entries: derive if missing; normalize if present
            # IMPORTANT: Some Special Class rows (esp. not offered in the term) may not have
            #           schedule_entries populated, but *do* have slot1/slot2 with schedule_id.
            #           We must normalize those slots and also populate schedule_entries so the UI
            #           can display room assignments even when the section isn't in regular offerings.
            se = r.get("schedule_entries")
            slot1_in = r.get("slot1") if isinstance(r.get("slot1"), dict) else None
            slot2_in = r.get("slot2") if isinstance(r.get("slot2"), dict) else None

            if not isinstance(se, list) or len(se) == 0:
                # Prefer slot1/slot2 when present
                slot_entries: List[Dict[str, Any]] = []
                if isinstance(slot1_in, dict):
                    slot_entries.append(slot1_in)
                if isinstance(slot2_in, dict):
                    slot_entries.append(slot2_in)

                if slot_entries:
                    se_norm = [_normalize_entry(e) for e in slot_entries if isinstance(e, dict)]
                    r["schedule_entries"] = se_norm
                else:
                    # Fallback to schedules by section_id (normal case)
                    scheds = sched_by_section.get(sid, []) if sid else []
                    scheds.sort(key=lambda x: (DAY_ORDER.get(_s(x.get("day")), 99), _hhmm(x.get("start_time"))))
                    se_norm = [_slot_from_sched(s) for s in scheds[:2]]
                    r["schedule_entries"] = se_norm
            else:
                r["schedule_entries"] = [_normalize_entry(e) for e in se if isinstance(e, dict)]

            # Always set slot1/slot2 from normalized schedule_entries so room_id/room_number display is consistent
            se2 = r.get("schedule_entries") if isinstance(r.get("schedule_entries"), list) else []
            r["slot1"] = se2[0] if len(se2) >= 1 else None
            r["slot2"] = se2[1] if len(se2) >= 2 else None

            # optional derived schedule_text
            if "schedule_text" not in r:
                r["schedule_text"] = _schedule_text(se2)

            r["program_name"] = prog_map.get(pid, "")
            r["department_name"] = dep_map.get(did, "")

            cinfo = course_map.get(cid, {})
            r["course_code"] = cinfo.get("course_code", "")
            r["course_title"] = cinfo.get("course_title", "")

            # student display name
            u = user_map.get(suid)
            r["student_name"] = caps_name(u) if u else (_s(r.get("student_name")) or "")

            # faculty display name: prefer stored faculty_name, else derive via faculty_profile -> users
            faculty_name = _s(r.get("faculty_name"))
            if not faculty_name:
                fid = _resolve_faculty_id(r)
                fp = fac_profile_map.get(fid) if fid else None

                if fp:
                    linked_uid = _s(fp.get("user_id"))
                    fu = user_map.get(linked_uid) if linked_uid else None
                    if fu:
                        faculty_name = caps_name(fu)
                    elif _s(fp.get("first_name")) or _s(fp.get("last_name")):
                        faculty_name = caps_name(fp)

            r["faculty_name"] = faculty_name or "UNASSIGNED"

        return rows


    if view == "specialclass":
        term = await _active_term_for_specialclass()
        term_id_sc = (term_id or "").strip() or (term or {}).get("term_id") or ""

        term_for_label = term
        if term_id_sc and (term or {}).get("term_id") != term_id_sc:
            term_for_label = await db[COL_TERMS].find_one({"term_id": term_id_sc}, {"_id": 0}) or term

        # normalize param name used in DB queries
        user_id = (userId or "").strip()  # ✅ IMPORTANT

        apo_user = await db[COL_USERS].find_one(
            {"user_id": user_id},
            {"_id": 0, "campus_name": 1, "campus": 1},
        )
        apo_campus = ((apo_user or {}).get("campus_name") or (apo_user or {}).get("campus") or "").strip()

        # Fetch rows ONCE
        rows = await _specialclass_rows(term_id_sc, {})

        # Ensure campus_name exists for UI filtering
        if apo_campus:
            for r in rows:
                if not (str(r.get("campus_name") or "").strip()):
                    r["campus_name"] = apo_campus

        return {
            "ok": True,
            "view": "specialclass",
            "campus": campus,
            "term_id": term_id_sc,
            "term_label": term_label(term_for_label),
            "rows": rows,
        }

    # ---- Offerings View ----
    room_opts: List[Dict[str, Any]] = [
        {"room_id": "", "room_number": "TBA", "capacity": None, "room_type": None},
    ]

    async for r in db[COL_ROOMS].find(
        {"campus_id": campus_id},
        {"_id": 0, "room_id": 1, "room_number": 1, "capacity": 1, "room_type": 1}
    ):
        room_opts.append({
            "room_id": r["room_id"],
            "room_number": r.get("room_number", r["room_id"]),
            "capacity": r.get("capacity"),
            "room_type": r.get("room_type"),
        })

    q_view: Dict[str, Any] = {"term_id": term_id, "campus_id": campus_id}

    if batch_id:
        # allow CSV: "id1,id2,id3" to represent all batches under one displayed ID label
        if "," in str(batch_id):
            parts = [x.strip() for x in str(batch_id).split(",") if x.strip()]
            q_view["batch_id"] = {"$in": parts} if parts else batch_id
        else:
            q_view["batch_id"] = batch_id

    if program_id:
        q_view["program_id"] = program_id


    curricula = [x async for x in db[COL_CURRICULUM].find(
        q_view,
        {"_id": 0, "curriculum_id": 1, "program_id": 1, "batch_id": 1, "term_id": 1, "course_list": 1}
    )]

    curricula_all_for_no = [x async for x in db[COL_CURRICULUM].find(
        {"term_id": term_id, "campus_id": campus_id},
        {"_id": 0, "program_id": 1, "batch_id": 1}
    )]

    batch_by_number, batch_by_id = await map_batches()

    prog_ids_view = list({c["program_id"] for c in curricula if c.get("program_id")})
    prog_ids_for_no = list({c["program_id"] for c in curricula_all_for_no if c.get("program_id")})
    prog_map_view = await map_programs(prog_ids_view)
    prog_map_all = await map_programs(prog_ids_for_no)

    all_course_ids = sorted(list({cid for c in curricula for cid in ensure_list(c.get("course_list"))}))
    c_map_all = await map_courses(all_course_ids)
    dep_ids_all = sorted(list({c_map_all[cid]["department_id"] for cid in c_map_all if c_map_all[cid].get("department_id")}))
    dep_map = await map_departments(dep_ids_all)

    def _norm_level_filter(x: Optional[str]) -> Optional[str]:
        if not x:
            return None
        code = level_code(x)
        if code == "GSM":
            return "Graduate Studies"
        if code == "UGS":
            return "Undergraduate"
        lx = (x or "").strip().lower()
        if lx.startswith("grad"):
            return "Graduate Studies"
        if lx.startswith("undergrad"):
            return "Undergraduate"
        return x

    norm_filter = _norm_level_filter(level)

    def level_ok(cid: str) -> bool:
        if not norm_filter:
            return True
        cm = c_map_all.get(cid, {})
        left = _norm_level_filter(cm.get("program_level_label") or cm.get("program_level"))
        return left == norm_filter

    def dept_ok(cid: str) -> bool:
        return (not department_id) or (c_map_all.get(cid, {}).get("department_id") == department_id)

    level_set = set()
    for cid, info in c_map_all.items():
        lbl = _norm_level_filter(info.get("program_level_label") or info.get("program_level"))
        if lbl in {"Undergraduate", "Graduate Studies"}:
            level_set.add(lbl)
    levels = [l for l in ["Undergraduate", "Graduate Studies"] if l in level_set]

    dep_opts = [{"department_id": d, "department_name": dep_map.get(d, {}).get("department_name", "")} for d in dep_ids_all]

    id_opts_unsorted: List[Dict[str, Any]] = []
    seen_batch_ids = set()
    for c in curricula:
        b = batch_by_id.get(c.get("batch_id") or "")
        if not b:
            continue
        bid = b["batch_id"]
        if bid in seen_batch_ids:
            continue
        seen_batch_ids.add(bid)
        id_opts_unsorted.append({
            "batch_id": bid,
            "batch_code": _norm_code(b.get("batch_code")),
            "batch_number": int(b.get("batch_number") or 0),
        })
    id_opts_unsorted.sort(key=lambda x: (-x["batch_number"], x["batch_code"]))
    id_opts = [{"batch_id": x["batch_id"], "batch_code": x["batch_code"]} for x in id_opts_unsorted]

    prog_opts, seen_prog = [], set()
    for c in curricula:
        pid = c.get("program_id")
        if not pid or pid in seen_prog:
            continue
        seen_prog.add(pid)
        prog_opts.append({"program_id": pid, "program_code": (prog_map_view.get(pid, {}) or {}).get("program_code", "")})

    allowed_course_ids = {cid for cid in all_course_ids if level_ok(cid) and dept_ok(cid)}

    elective_specific_pool: List[Dict[str, Any]] = []
    async for e in db[COL_COURSES].find(
        {
            "$or": [
                {"type_of_course": {"$regex": r"\belective\s*course\b", "$options": "i"}},
                {
                    "$and": [
                        {"type_of_course": {"$regex": r"elective", "$options": "i"}},
                        {"type_of_course": {"$not": {"$regex": r"^\s*elective\s*$", "$options": "i"}}}
                    ]
                }
            ]
        },
        {
            "_id": 0,
            "course_id": 1,
            "course_code": 1,
            "course_title": 1,
            "department_id": 1,
            "program_level": 1
        }
    ):
        code = _code_str(e.get("course_code"))
        elective_specific_pool.append({
            "course_id": e["course_id"],
            "course_code": code,
            "course_title": e.get("course_title", ""),
            "department_id": e.get("department_id", ""),
            "program_level": e.get("program_level", ""),
        })

    all_specific_electives = sorted(
        elective_specific_pool,
        key=lambda x: (x.get("course_code") or "").upper()
    )

    # Provide a flat, globally-sorted list for the UI (not dept-scoped)
    all_specific_electives = sorted(
        elective_specific_pool,
        key=lambda x: (x.get("course_code") or "").upper()
)

    electives_by_dep: Dict[str, List[Dict[str, Any]]] = {}
    for e in elective_specific_pool:
        electives_by_dep.setdefault(e["department_id"], []).append({
            "course_id": e["course_id"],
            "course_code": e["course_code"],
            "course_title": e["course_title"],
        })
    for k in electives_by_dep:
        electives_by_dep[k].sort(key=lambda x: x["course_code"])

    non_placeholder_by_dep: Dict[str, List[Dict[str, Any]]] = {}
    async for e in db[COL_COURSES].find(
        {"type_of_course": {"$not": {"$regex": r"^\s*elective\s*$", "$options": "i"}}},
        {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1, "department_id": 1}
    ):
        code = _code_str(e.get("course_code"))
        non_placeholder_by_dep.setdefault(e.get("department_id",""), []).append(
            {"course_id": e.get("course_id",""), "course_code": code, "course_title": e.get("course_title","")}
        )
    for k in non_placeholder_by_dep:
        non_placeholder_by_dep[k].sort(key=lambda x: x["course_code"])

    options_by_group: Dict[str, List[Dict[str, Any]]] = {}
    for cur in curricula:
        key = f'{cur.get("batch_id","")}|{cur.get("program_id","")}'
        opts: List[Dict[str, Any]] = []
        for cid in ensure_list(cur.get("course_list")):
            if cid not in allowed_course_ids:
                continue
            cm = c_map_all.get(cid, {})
            if not cm:
                continue
            opt_item: Dict[str, Any] = {
                "course_id": cid,
                "course_code": cm.get("course_code", ""),
                "course_title": cm.get("course_title", ""),
                "type_of_course": cm.get("type_of_course", ""),
            }
            if _ctype(cm.get("type_of_course")) == ELECTIVE_PLACEHOLDER:
                opt_item["is_elective_placeholder"] = True
                opt_item["elective_options"] = all_specific_electives
            opts.append(opt_item)

        seen, uniq = set(), []
        for o in opts:
            if o["course_id"] in seen:
                continue
            seen.add(o["course_id"]); uniq.append(o)
        options_by_group[key] = sorted(uniq, key=lambda x: x["course_code"])

    needs_import, approval_required, pending, preen_hash, cohort_hash, plan_state = await _planning_flags(
        term_id=term_id, campus_id=campus_id, campus_prefix=prefix_default
    )

    campus_sec_by_course: Dict[str, List[Dict[str, Any]]]= {}
    planned_capacity_by_course: Dict[str, int] = {}

    for cid in allowed_course_ids:
        lvl = (c_map_all.get(cid) or {}).get("program_level")
        pref_pat = prefix_pattern_for_level(campus.get("campus_name",""), lvl)
        # Hide soft-deleted (archived) sections from APO view immediately.
        # OM will keep seeing the old snapshot until APO re-submits, but APO should no longer see the deleted row.
        sec_q: Dict[str, Any] = {
            "term_id": term_id,
            "campus_id": campus_id,
            "status": {"$ne": "archived"},
            "$or": [{"course_id": cid}, {"fulfilled_placeholder_course_id": cid}],
        }
        if pref_pat:
            sec_q["section_code"] = {"$regex": f"^{pref_pat}", "$options": "i"}

        secs = [s async for s in db[COL_SECTIONS].find(
            sec_q, {"_id": 0, "section_id": 1, "section_code": 1, "enrollment_cap": 1, "remarks": 1, "batch_number": 1,
                    "course_id": 1, "fulfilled_placeholder_course_id": 1}
        )]
        campus_sec_by_course[cid] = secs
        planned_capacity_by_course[cid] = sum(int(s.get("enrollment_cap") or DEFAULT_CAP) for s in secs)

    offered_ids: set = set()
    for cid, secs in campus_sec_by_course.items():
        for s in secs:
            if s.get("course_id"):
                offered_ids.add(s.get("course_id"))
    missing_offered = [x for x in offered_ids if x not in c_map_all]
    if missing_offered:
        c_map_all.update(await map_courses(missing_offered))

    def _bn(bid: Optional[str]) -> int:
        b = batch_by_id.get(bid or "", {})
        try:
            return int(b.get("batch_number") or 0)
        except Exception:
            return 0

    def _pc_view(pid: Optional[str]) -> str:
        return (prog_map_view.get(pid or "", {}) or {}).get("program_code", "") or ""

    curricula_all_sorted = sorted(
        curricula_all_for_no,
        key=lambda x: (-_bn(x.get("batch_id")), (prog_map_all.get(x.get("program_id",""), {}) or {}).get("program_code","") or "")
    )
    prog_no_label_map: Dict[Tuple[str, str], str] = {}
    per_batch_seq: Dict[str, int] = {}
    for cur in curricula_all_sorted:
        bid = cur.get("batch_id") or ""
        pid = cur.get("program_id") or ""
        pc = (prog_map_all.get(pid, {}) or {}).get("program_code", "") or "PROG"
        per_batch_seq[bid] = per_batch_seq.get(bid, 0) + 1
        prog_no_label_map[(bid, pid)] = f"{pc}-{per_batch_seq[bid]}"

    curricula_sorted = sorted(curricula, key=lambda x: (-_bn(x.get("batch_id")), _pc_view(x.get("program_id"))))

    block_keys_by_course: Dict[str, List[Tuple[str, str, str, int]]] = {}
    for cur in curricula_sorted:
        bid = cur.get("batch_id", "")
        pid = cur.get("program_id", "")
        binfo = batch_by_id.get(bid or "", {})
        bn = int(binfo.get("batch_number") or 0)
        label = prog_no_label_map.get((bid, pid), "PROG-?")
        for course_id in ensure_list(cur.get("course_list")):
            if course_id in allowed_course_ids:
                block_keys_by_course.setdefault(course_id, []).append((bid, pid, label, bn))

    distribution_by_course: Dict[str, Dict[Tuple[str, str], List[Dict[str, Any]]]] = {}
    for cid in allowed_course_ids:
        owners = _unique_owners_in_order(block_keys_by_course.get(cid, []))
        distribution_by_course[cid] = _distribute_sections_round_robin(campus_sec_by_course.get(cid, []), owners)

    rows: List[Dict[str, Any]] = []

    def _clean_time(s: Optional[str]) -> Optional[str]:
        if not s:
            return None
        t = "".join(ch for ch in str(s) if ch.isdigit())
        return t if len(t) == 4 else None

    def _slot_from_payload(p: Optional[dict], allow_room_only: bool = False) -> Optional[dict]:
        if not isinstance(p, dict):
            return None
        day = (p.get("day") or "").strip()
        st = _clean_time(p.get("start_time"))
        en = _clean_time(p.get("end_time"))
        room = p.get("room_id")
        if allow_room_only and room and not (day and st and en):
            return {"room_id": room}
        if not (day and st and en):
            return None
        out = {"day": day, "start_time": st, "end_time": en}
        if room:
            out["room_id"] = room
        return out

    async def first_faculty_name_for_section(term_id: str, section_id: str) -> Tuple[str, Optional[str], Optional[str]]:
        # Prefer a non-archived assignment for this term; fall back to any non-archived
        fa = await db[COL_FAC_ASSIGN].find_one(
            {"term_id": term_id, "section_id": section_id, "is_archived": {"$ne": True}},
            {"_id": 0, "user_id": 1, "faculty_id": 1}
        )
        if not fa:
            fa = await db[COL_FAC_ASSIGN].find_one(
                {"section_id": section_id, "is_archived": {"$ne": True}},
                {"_id": 0, "user_id": 1, "faculty_id": 1}
            )
        if not fa:
            return ("UNASSIGNED", None, None)

        uid = (fa.get("user_id") or "") or None
        fid = (fa.get("faculty_id") or "") or None

        # If the assignment carries a user_id, use USERS directly for the display name
        if uid:
            u = await db[COL_USERS].find_one(
                {"user_id": uid}, {"_id": 0, "first_name": 1, "last_name": 1, "middle_name": 1}
            )
            if u:
                return (caps_name(u), uid, fid)
            # fallthrough: user missing -> try faculty profile

        # If we only have faculty_id, find profile. If that has user_id, hop to USERS.
        if fid:
            fp = await db[COL_FAC_PROFILES].find_one(
                {"faculty_id": fid},
                {"_id": 0, "first_name": 1, "last_name": 1, "middle_name": 1, "user_id": 1}
            )
            if fp:
                linked_uid = fp.get("user_id") or None
                if linked_uid:
                    u = await db[COL_USERS].find_one(
                        {"user_id": linked_uid}, {"_id": 0, "first_name": 1, "last_name": 1, "middle_name": 1}
                    )
                    if u:
                        return (caps_name(u), linked_uid, fid)
                # fallback: use name stored in faculty_profiles
                if fp.get("first_name") or fp.get("last_name"):
                    return (caps_name(fp), linked_uid, fid)

        return ("UNASSIGNED", uid, fid)

    async def slot_payload_from_schedules(sid: str):
        scheds = [x async for x in db[COL_SCHEDS].find(
            {"section_id": sid},
            {"_id": 0, "schedule_id": 1, "section_id": 1, "day": 1,
            "start_time": 1, "end_time": 1, "room_id": 1, "room_type": 1}
        )]

        def _has_info(s: dict) -> bool:
            has_time = bool(s.get("day") and s.get("start_time") and s.get("end_time"))
            has_room = bool((s.get("room_id") or "").strip())
            return has_time or has_room

        # Monday..Saturday order (not alphabetical)
        _DOW_RANK = {"Monday":1, "Tuesday":2, "Wednesday":3, "Thursday":4, "Friday":5, "Saturday":6}

        def _start_num(v: str) -> int:
            t = "".join(ch for ch in str(v or "") if ch.isdigit())
            try:
                return int(t)  # "0730" -> 730
            except Exception:
                return 0

        def _key(s: dict):
            # 1) prefer entries that have time/room info
            info_rank = 0 if _has_info(s) else 1
            # 2) sort by weekday rank
            day_name = normalize_day(s.get("day"))
            day_rank = _DOW_RANK.get(day_name, 99)
            # 3) then by start time
            return (info_rank, day_rank, _start_num(s.get("start_time")))

        picked = sorted(scheds, key=_key)[:2]

        # Map room_id -> room_number for any referenced rooms
        rids = list({sc.get("room_id") for sc in picked if sc.get("room_id")})
        rmap: Dict[str, str] = {}
        if rids:
            async for r in db[COL_ROOMS].find(
                {"room_id": {"$in": rids}}, {"_id": 0, "room_id": 1, "room_number": 1}
            ):
                rmap[r["room_id"]] = r.get("room_number") or r["room_id"]

        def slot_payload(x: Optional[Dict[str, Any]]):
            if not x:
                return None
            rid = (x.get("room_id") or "").strip()

            # ONLINE should never display; treat it as blank/TBA
            if rid.upper() == "ONLINE":
                rid = ""

            room_number = rmap.get(rid, "")
            if not room_number:
                if rid:
                    room_number = rid  # fallback if not in room map
                else:
                    room_number = "TBA"

            return {
                "schedule_id": x.get("schedule_id", ""),
                "day": normalize_day(x.get("day")),
                "start_time": x.get("start_time", ""),
                "end_time": x.get("end_time", ""),
                "room_id": rid,
                "room_number": room_number,
                "room_type": (x.get("room_type") or ""),
            }

        slot1 = slot_payload(picked[0]) if len(picked) >= 1 else None
        slot2 = slot_payload(picked[1]) if len(picked) >= 2 else None
        return (slot1, slot2)


    for cur in curricula_sorted:
        bid = cur.get("batch_id", "")
        pid = cur.get("program_id", "")
        binfo = batch_by_id.get(bid or "", {})
        batch_num = int(binfo.get("batch_number") or 0)
        prog_no_base = prog_no_label_map.get((bid, pid), "PROG-?")

        for course_id in ensure_list(cur.get("course_list")):
            if course_id not in allowed_course_ids:
                continue
            cinfo = c_map_all.get(course_id, {})
            dep_name = dep_map.get(cinfo.get("department_id", ""), {}).get("department_name", "")

            est = await estimated_demand(term_id, campus_id, course_id)
            total_intent = est["plan"]
            preen_total = est["preen"]
            cohort_est = est["cohort"]
            planned_cap = planned_capacity_by_course.get(course_id, 0)
            existing_sections = len(campus_sec_by_course.get(course_id, []))
            eff_cap_new = await effective_section_capacity(term_id, campus.get("campus_name",""), course_id) or DEFAULT_CAP
            deficit = max(0, (total_intent or 0) - planned_cap)
            suggest_additional = ceil(deficit / eff_cap_new) if deficit > 0 else 0
            suggest_total_sections = existing_sections + suggest_additional

            course_payload = {
                "course_id": course_id,
                "course_code": cinfo.get("course_code",""),
                "course_title": cinfo.get("course_title",""),
                "program_level": cinfo.get("program_level",""),
                "program_level_label": cinfo.get("program_level_label",""),
                "department_id": cinfo.get("department_id",""),
                "department_name": dep_name,
                "type_of_course": cinfo.get("type_of_course",""),
            }

            my_sections = distribution_by_course.get(course_id, {}).get((bid, pid), [])

            def sizing_payload():
                return {
                    "preenlistment_total": preen_total or 0,
                    "cohort_estimate": cohort_est or 0,
                    "planning_demand": total_intent or 0,
                    "planned_capacity": planned_cap,
                    "existing_sections": existing_sections,
                    "suggest_additional": suggest_additional,
                    "deficit": deficit,
                }

            if not my_sections:
                rows.append({
                    "program_no": f"{prog_no_base}-1",
                    "batch": {"batch_id": binfo.get("batch_id", ""), "batch_code": _norm_code(binfo.get("batch_code")), "batch_number": batch_num or None},
                    "program": {"program_id": pid, "program_code": (prog_map_view.get(pid, {}) or {}).get("program_code", "")},
                    "course": course_payload,
                    "section": {"section_id": "", "section_code": "", "enrollment_cap": None, "remarks": ""},
                    "faculty": {"faculty_id": None, "user_id": None, "faculty_name": "UNASSIGNED"},
                    "slot1": None, "slot2": None,
                    "links": {"curriculum_id": cur.get("curriculum_id"), "term_id": term_id, "course_id": course_id, "batch_id": binfo.get("batch_id", ""), "program_id": pid,
                              "fulfilled_placeholder_course_id": course_id},
                    "sizing": sizing_payload(),
                })
            else:
                for idx, s in enumerate(my_sections, start=1):
                    sid = s["section_id"]
                    slot1, slot2 = await slot_payload_from_schedules(sid)
                    faculty_name, user_id_res, faculty_id_res = await first_faculty_name_for_section(term_id, sid)

                    offered_cid = s.get("course_id")
                    offered_info = c_map_all.get(offered_cid, {})
                    offered_payload = None
                    if offered_cid and (offered_cid != course_id or _ctype(cinfo.get("type_of_course")) == ELECTIVE_PLACEHOLDER):
                        offered_payload = {
                            "course_id": offered_cid,
                            "course_code": offered_info.get("course_code", ""),
                            "course_title": offered_info.get("course_title", ""),
                            "type_of_course": offered_info.get("type_of_course", ""),
                        }

                    _display_course = offered_payload or course_payload
                    _placeholder_course = (
                        course_payload
                        if (offered_payload and _ctype(cinfo.get("type_of_course")) == ELECTIVE_PLACEHOLDER)
                        else None
                    )

                    rows.append({
                        "program_no": f"{prog_no_base}-{idx}",
                        "block_index": idx,
                        "batch": {
                            "batch_id": binfo.get("batch_id", ""),
                            "batch_code": _norm_code(binfo.get("batch_code")),
                            "batch_number": batch_num or None,
                        },
                        "program": {"program_id": pid, "program_code": (prog_map_view.get(pid, {}) or {}).get("program_code", "")},
                        "course": _display_course,
                        "offered_course": offered_payload,
                        "placeholder_course": _placeholder_course,
                        "section": {
                            "section_id": sid,
                            "section_code": s.get("section_code", ""),
                            "enrollment_cap": s.get("enrollment_cap"),
                            "remarks": s.get("remarks", ""),
                        },
                        "faculty": {"faculty_id": faculty_id_res, "user_id": user_id_res, "faculty_name": faculty_name},
                        "slot1": slot1,
                        "slot2": slot2,
                        "links": {
                            "curriculum_id": cur.get("curriculum_id"),
                            "term_id": term_id,
                            "course_id": course_id,  # still the placeholder owner for grouping/demand
                            "course_id": course_id,
                            "batch_id": binfo.get("batch_id", ""),
                            "program_id": pid,
                            "section_id": sid,
                            "fulfilled_placeholder_course_id": s.get("fulfilled_placeholder_course_id") or "",
                        },
                        "sizing": sizing_payload(),
                    })

    def _sec_num(code: str) -> int:
        return int("".join(ch for ch in (code or "") if ch.isdigit()) or "0")

    rows.sort(key=lambda r: (
        -(r.get("batch", {}).get("batch_number") or 0),
        (r.get("program", {}).get("program_code") or ""),
        (r.get("block_index") or 1),
        (r.get("course", {}).get("course_code") or ""),
        _sec_num((r.get("section", {}) or {}).get("section_code") or "")
    ))

    return {
        "campus": campus,
        "term_id": term_id,
        "term_label": term_label(planning_term), 
        "filters": {"levels": levels, "departments": dep_opts, "ids": id_opts, "programs": prog_opts},
        "rows": rows,
        "course_options_by_group": options_by_group,
        "all_specific_electives": all_specific_electives,
        "room_options": room_opts,
        "om_submit_window": om_submit_window,
        "planning": {
            "needs_import": needs_import,
            "approval_required": approval_required,
            "pending_changes": pending if approval_required else []
        }
    }

# ---------- POST ----------
@router.post("/courseofferings")
async def post_course_offerings(
    userId: str = Query(..., min_length=3),
    action: Literal[
        "addRow", "editRow", "deleteRow", "restoreRow", "forward",
        "curriculumAddCourse", "curriculumEditCourse", "curriculumRemoveCourse",
        "approvePlan",
        "specialclassUpdate", 
        "courseCatalog", "search_catalog",
        "catalog.create", 
        "curriculumImportCsv", "curriculum.importCsv",
        "import_curriculum_csv",
        "setOmSubmitWindow"
    ] = Query(...),
    payload: Optional[Dict[str, Any]] = Body(None),
):

    # Use the same PLANNING term as Preenlistment
    planning_term = await _get_planning_term()
    term_id = (planning_term or {}).get("term_id")

    if not term_id:
        raise HTTPException(status_code=400, detail="No planning term (next term) found.")

    # Keep status flags in sync for the planning term
    await _sync_section_status_flags(term_id)

    campus_id, _ = await apo_scope(userId)
    if not campus_id:
        raise HTTPException(status_code=400, detail="Unable to resolve APO campus from role_assignments.")
    campus = await campus_meta(campus_id)
    prefix_default = campus_section_prefix(campus.get("campus_name", "")) or ""

    # OM submission deadline window (set by APO per campus + planning term)
    om_submit_window = await _get_om_submit_window(term_id, campus_id)

    # ---------- OM SUBMISSION DEADLINE WINDOW (set by APO; consumed by OM) ----------
    if action == "setOmSubmitWindow":
        if payload is None or not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="Missing payload.")

        deadline_iso = str(payload.get("deadlineISO") or payload.get("deadline_iso") or payload.get("deadline") or "").strip()
        if not deadline_iso:
            raise HTTPException(status_code=422, detail="deadlineISO is required")

        deadline_dt = _parse_iso_dt(deadline_iso)
        if not deadline_dt:
            raise HTTPException(status_code=422, detail="Invalid deadlineISO; must be ISO8601")

        now_dt = datetime.now(timezone.utc).replace(microsecond=0)
        now_iso = now_dt.isoformat()

        # Normalize to UTC + remove sub-second precision to keep the UI clean/consistent.
        deadline_dt = deadline_dt.astimezone(timezone.utc).replace(microsecond=0)
        deadline_iso_out = deadline_dt.isoformat()

        await db[COL_OM_SUBMIT_WINDOWS].update_one(
            {"term_id": term_id, "campus_id": campus_id},
            {
                "$set": {
                    "term_id": term_id,
                    "campus_id": campus_id,
                    # window is considered open as soon as APO sets it
                    "openISO": now_iso,
                    "deadlineISO": deadline_iso_out,
                    "updated_by": userId,
                    "updated_at": now_iso,
                },
                "$setOnInsert": {"created_at": now_iso},
            },
            upsert=True,
        )

        # Notify OM + GS Coordinator immediately that a deadline was set/updated.
        # Reminder notifications are automatic (7/3/2/1 days before deadline) via:
        #   /api/notifications/run-om-submit-deadline-reminders
        try:
            recipients = await _om_and_gs_user_ids_for_campus(campus_id, db)
            if recipients:
                campus_name = (campus.get("campus_name") or str(campus_id) or "").strip()
                deadline_txt = deadline_dt.strftime("%b %d, %Y %H:%M UTC")

                title = "OM Submission Deadline Set"
                details = (
                    f"APO set the OM submission deadline for {term_id} ({campus_name}). "
                    f"Deadline: {deadline_txt}. "
                    f"Automatic reminders will be sent 7, 3, 2, and 1 day(s) before the deadline."
                )

                dedupe_key = f"om_submit_window_set::{term_id}::{campus_id}::{deadline_iso_out}"
                for uid in recipients:
                    hit = await db["notifications"].find_one(
                        {"user_id": uid, "meta.dedupe_key": dedupe_key},
                        {"_id": 1},
                    )
                    if hit:
                        continue

                    await create_notification(
                        uid,
                        title,
                        details,
                        meta={
                            "kind": "om_submit_window_set",
                            "term_id": term_id,
                            "campus_id": campus_id,
                            "deadlineISO": deadline_iso_out,
                            "dedupe_key": dedupe_key,
                            "route": "/om/load-assignment",
                        },
                        send_email=True,
                        email_from_user_id=userId,
                    )


                # Also: if today already falls in a reminder window (7/3/2/1 days before),
                # send that reminder immediately so APO can verify the reminder system.
                # (Future reminders are still generated via /api/notifications/run-om-submit-deadline-reminders.)
                targets = (7, 3, 2, 1)
                for days_left in targets:
                    start = deadline_dt - timedelta(days=days_left)
                    end = deadline_dt - timedelta(days=days_left - 1)
                    if not (start <= now_dt < end):
                        continue

                    when_txt2 = deadline_dt.strftime("%b %d, %Y %H:%M UTC")
                    title2 = "OM Submission Due in 1 day" if days_left == 1 else f"OM Submission Due in {days_left} days"
                    details2 = f"Please approve the OM Load Assignment for term {term_id} before {when_txt2}."

                    dd = f"om_submit_deadline::{term_id}::{campus_id}::{days_left}::{deadline_iso_out}"
                    for uid in recipients:
                        hit2 = await db["notifications"].find_one(
                            {"user_id": uid, "meta.dedupe_key": dd},
                            {"_id": 1},
                        )
                        if hit2:
                            continue

                        await create_notification(
                            uid,
                            title2,
                            details2,
                            meta={
                                "kind": "om_submit_deadline_reminder",
                                "term_id": term_id,
                                "campus_id": campus_id,
                                "deadlineISO": deadline_iso_out,
                                "days_left": days_left,
                                "dedupe_key": dd,
                                "route": "/om/load-assignment",
                            },
                            send_email=True,
                            email_from_user_id=userId,
                        )
                    break
        except Exception:
            pass

        return {
            "ok": True,
            "term_id": term_id,
            "campus_id": campus_id,
            "om_submit_window": {
                "openISO": now_iso,
                "deadlineISO": deadline_iso_out,
            },
        }

# ---------- SPECIAL CLASS (APO inline edit: remarks + optional room updates) ----------
    if action == "specialclassUpdate":
        if payload is None:
            raise HTTPException(status_code=400, detail="Missing payload.")

        special_id = (payload.get("special_id") or payload.get("specialId") or "").strip()
        if not special_id:
            raise HTTPException(status_code=422, detail="special_id is required.")

        # Use payload term_id if provided; fallback to planning term used by this endpoint
        term_id_target = (payload.get("term_id") or payload.get("termId") or term_id or "").strip()
        if not term_id_target:
            raise HTTPException(status_code=422, detail="term_id is required.")

        base = await db[COL_SPECIAL].find_one(
            {"term_id": term_id_target, "special_id": special_id},
            {"_id": 0, "special_id": 1, "term_id": 1, "section_id": 1, "schedule_entries": 1, "assignment_id": 1, "course_id": 1, "section_code": 1},
        )
        if not base:
            raise HTTPException(status_code=404, detail="Special class record not found.")

        updates: Dict[str, Any] = {"updated_at": now()}

        if "remarks" in payload:
            updates["remarks"] = payload.get("remarks") or ""

        await db[COL_SPECIAL].update_one(
            {"term_id": term_id_target, "special_id": special_id},
            {"$set": updates},
        )

        # Optional: persist room edits by updating the section_schedules records
        # IMPORTANT: validate using the same rules as Room Allocation / eligibleRooms:
        # - capacity (rooms.capacity >= sections.enrollment_cap)
        # - room_type match (per-slot schedule.room_type, fallback to course.room_type)
        # - room availability day/time
        # - overlap conflicts (term-aware)
        se = payload.get("schedule_entries")
        if isinstance(se, list):
            section_id_sc = (base.get("section_id") or "").strip()

            # Validate schedule_ids belong to this special class record (prevents updating unrelated schedules)
            allowed_sched_ids: set[str] = set()
            base_se = base.get("schedule_entries")
            if isinstance(base_se, list):
                for ent in base_se[:2]:
                    if isinstance(ent, dict):
                        sid0 = str(ent.get("schedule_id") or "").strip()
                        if sid0:
                            allowed_sched_ids.add(sid0)

            # Normalize helper (local to this action)
            def _t4_local(v: Any) -> str:
                s = "".join(ch for ch in str(v) if ch.isdigit())
                if not s:
                    return ""
                if len(s) < 4:
                    s = ("0000" + s)[-4:]
                return s[:4]

            # Gather schedule_ids being edited so we can exclude them from conflict checks
            edited_sched_ids = [str(e.get("schedule_id") or "").strip() for e in se[:2] if isinstance(e, dict)]
            edited_sched_ids = [x for x in edited_sched_ids if x]

            async def _validate_room_change(schedule_doc: Dict[str, Any], new_room_id: str) -> None:
                # room must exist in campus scope
                room = await db[COL_ROOMS].find_one(
                    {"room_id": new_room_id, "campus_id": campus_id},
                    {"_id": 0, "room_id": 1, "capacity": 1, "room_type": 1},
                )
                if not room:
                    raise HTTPException(status_code=400, detail=f"Room {new_room_id} not found in your campus scope.")

                # capacity: room.capacity must be >= section.enrollment_cap (if known)
                room_cap = int(room.get("capacity") or 0)
                sec_cap = 0
                sec = None
                sec_id0 = (schedule_doc.get("section_id") or section_id_sc or "").strip()
                if sec_id0:
                    sec = await db[COL_SECTIONS].find_one(
                        {"section_id": sec_id0},
                        {"_id": 0, "section_id": 1, "enrollment_cap": 1, "course_id": 1, "term_id": 1},
                    )
                try:
                    v = (sec or {}).get("enrollment_cap")
                    sec_cap = int(v) if v not in (None, "") else 0
                except Exception:
                    sec_cap = 0

                if room_cap and sec_cap and room_cap < sec_cap:
                    raise HTTPException(status_code=400, detail=f"Section enrollment cap ({sec_cap}) exceeds room capacity ({room_cap}).")

                # room_type: prefer schedule.room_type; fallback to course.room_type
                room_rt = normalize_room_type(room.get("room_type") or "")
                need_rt = normalize_room_type(schedule_doc.get("room_type") or "")
                if not need_rt and sec and sec.get("course_id"):
                    c = await db[COL_COURSES].find_one(
                        {"course_id": sec.get("course_id")},
                        {"_id": 0, "room_type": 1},
                    )
                    v = (c or {}).get("room_type")
                    if isinstance(v, list) and v:
                        need_rt = normalize_room_type(v[0])
                    elif isinstance(v, str):
                        need_rt = normalize_room_type(v)

                if need_rt and room_rt and need_rt != room_rt:
                    raise HTTPException(status_code=400, detail=f"Room type '{room_rt}' is not compatible with required '{need_rt}' for this section.")

                # availability (same rule as eligibleRooms)
                day_full = normalize_day(schedule_doc.get("day"))
                st = _t4_local(schedule_doc.get("start_time"))
                et = _t4_local(schedule_doc.get("end_time"))
                if not (day_full and st and et):
                    raise HTTPException(status_code=400, detail=f"Invalid schedule day/time for schedule {schedule_doc.get('schedule_id') }.")

                avail_pairs: Set[Tuple[str, str]] = set()
                async for a in db[COL_SCHEDS].find(
                    {"room_id": new_room_id, "section_id": {"$exists": False}, "day": {"$in": day_aliases(day_full)}},
                    {"_id": 0, "start_time": 1, "end_time": 1},
                ):
                    st0 = _t4_local(a.get("start_time"))
                    et0 = _t4_local(a.get("end_time"))
                    if st0 and et0:
                        avail_pairs.add((st0, et0))

                default_days = default_open_days_for_campus(campus.get("campus_name", ""))
                if avail_pairs:
                    if (st, et) not in avail_pairs:
                        raise HTTPException(status_code=400, detail=f"Room is not available for {day_full} {st}-{et}.")
                else:
                    if day_full not in default_days:
                        raise HTTPException(status_code=400, detail=f"Room is not available for {day_full} {st}-{et}.")

                # overlap conflicts (term-aware)
                overlaps: List[str] = []
                async for x in db[COL_SCHEDS].find(
                    {"room_id": new_room_id, "section_id": {"$exists": True}, "day": {"$in": day_aliases(day_full)}},
                    {"_id": 0, "schedule_id": 1, "section_id": 1, "start_time": 1, "end_time": 1},
                ):
                    if str(x.get("schedule_id") or "").strip() in edited_sched_ids:
                        continue
                    other_sid = str(x.get("section_id") or "").strip()
                    if not other_sid:
                        continue
                    st0 = _t4_local(x.get("start_time"))
                    et0 = _t4_local(x.get("end_time"))
                    if not (st0 and et0):
                        continue
                    if int(st0) < int(et) and int(et0) > int(st):
                        overlaps.append(other_sid)

                if overlaps:
                    other_sec_ids = sorted(set(overlaps))
                    # only block if the conflicting section is in the same term
                    in_same_term = await db[COL_SECTIONS].find_one(
                        {"section_id": {"$in": other_sec_ids}, "term_id": term_id_target},
                        {"_id": 1},
                    )
                    if in_same_term:
                        raise HTTPException(status_code=400, detail=f"Room already assigned (overlap) for {day_full} {st}-{et}.")

            for e in se[:2]:
                if not isinstance(e, dict):
                    continue

                sched_id = str(e.get("schedule_id") or "").strip()
                if not sched_id:
                    continue

                # Load the schedule doc (source of truth for day/time/section)
                sch = await db[COL_SCHEDS].find_one(
                    {"schedule_id": sched_id},
                    {"_id": 0, "schedule_id": 1, "section_id": 1, "day": 1, "start_time": 1, "end_time": 1, "room_type": 1},
                )
                if not sch:
                    raise HTTPException(status_code=404, detail=f"Schedule not found: {sched_id}")

                # Ensure this schedule_id belongs to the special class record (if schedule_entries exist in the record).
                # This is safer than strict section_id equality because some legacy special_class rows may have
                # stale/missing section_id even though the schedule_id is correct.
                if allowed_sched_ids and sched_id not in allowed_sched_ids:
                    raise HTTPException(status_code=400, detail=f"Schedule {sched_id} is not part of this special class record.")

                sch_section_id = str(sch.get("section_id") or "").strip()

                # If special_class.section_id is missing, persist it from the schedule for better future joins
                if not section_id_sc and sch_section_id:
                    section_id_sc = sch_section_id
                    await db[COL_SPECIAL].update_one(
                        {"term_id": term_id_target, "special_id": special_id},
                        {"$set": {"section_id": section_id_sc, "updated_at": now()}},
                    )

                # If special_class.section_id exists but does not match the schedule's section_id, repair it (do not block).
                # The schedule_id is the source of truth for which section we are editing.
                if sch_section_id and section_id_sc and sch_section_id != section_id_sc:
                    section_id_sc = sch_section_id
                    await db[COL_SPECIAL].update_one(
                        {"term_id": term_id_target, "special_id": special_id},
                        {"$set": {"section_id": section_id_sc, "updated_at": now()}},
                    )

                room_id_raw = e.get("room_id")
                room_id = (str(room_id_raw).strip() if room_id_raw is not None else "")

                set_doc: Dict[str, Any] = {"updated_at": now()}

                # Empty means TBA => clear room_id in DB
                if room_id == "" or room_id.lower() in {"null", "none"}:
                    set_doc["room_id"] = None
                else:
                    # validate before setting
                    await _validate_room_change(sch, room_id)
                    set_doc["room_id"] = room_id

                qsch: Dict[str, Any] = {"schedule_id": sched_id}
                if section_id_sc:
                    qsch["section_id"] = section_id_sc

                await db[COL_SCHEDS].update_one(qsch, {"$set": set_doc})

        return {"ok": True}

    # ---------- NEW: CSV CURRICULUM IMPORT ----------
    if action in ("curriculumImportCsv", "curriculum.importCsv", "import_curriculum_csv"):
        if payload is None:
            raise HTTPException(status_code=400, detail="Missing payload.")

        # Allow either { "rows": [...] } or [ ... ] from the frontend
        if isinstance(payload, list):
            rows = payload
        elif isinstance(payload, dict):
            rows = payload.get("rows") or []
        else:
            raise HTTPException(
                status_code=400,
                detail="Payload must be either an array of rows or an object with a 'rows' array."
            )

        if not isinstance(rows, list):
            raise HTTPException(
                status_code=400,
                detail="payload.rows must be a list of row dicts parsed from the CSV."
            )

        results: List[Dict[str, Any]] = []
        errors: List[Dict[str, Any]] = []

        # helpers to read columns regardless of exact casing
        def _get(row: Dict[str, Any], *names: str) -> str:
            if not row:
                return ""
            lower_map = {k.lower(): k for k in row.keys() if isinstance(k, str)}
            for name in names:
                if name in row:
                    return str(row[name] or "").strip()
                key = lower_map.get(name.lower())
                if key:
                    return str(row[key] or "").strip()
            return ""

        meta_keys = {
            "batch", "program level", "level",
            "program", "program code",
            "term number", "term",
            "academic year", "ay",
            "campus",
        }
        meta_keys_lower = {k.lower() for k in meta_keys}

        for idx, raw in enumerate(rows, start=1):
            try:
                row = raw or {}

                # --- NEW: skip rows that are completely empty (common trailing CSV row) ---
                if not any((str(v).strip() for v in row.values() if v is not None)):
                    continue

                batch_label        = _get(row, "Batch")
                program_level_lbl  = _get(row, "Program Level", "Level")
                program_code       = _get(row, "Program", "Program Code")
                term_number_str    = _get(row, "Term Number", "Term")
                acad_year_str      = _get(row, "Academic Year", "AY")
                campus_label       = _get(row, "Campus")

                if not batch_label or not program_code or not term_number_str or not acad_year_str:
                    raise HTTPException(
                        status_code=422,
                        detail=f"Row {idx}: Batch, Program, Term Number, and Academic Year are required."
                    )

                # parse ints
                try:
                    term_number = int(term_number_str)
                except Exception:
                    raise HTTPException(status_code=422, detail=f"Row {idx}: invalid Term Number '{term_number_str}'.")

                try:
                    acad_year_start = int(acad_year_str)
                except Exception:
                    raise HTTPException(status_code=422, detail=f"Row {idx}: invalid Academic Year '{acad_year_str}'.")

                # campus: if cell empty, default to APO campus
                campus_name_csv = campus_label.strip() if campus_label else ""
                campus_id_row = campus_id
                campus_name_row = campus.get("campus_name", "")

                if campus_name_csv:
                    # Try a flexible match (substring / case-insensitive) against campus_name
                    campus_doc = await db[COL_CAMPUSES].find_one(
                        {"campus_name": {"$regex": re.escape(campus_name_csv), "$options": "i"}},
                        {"_id": 0, "campus_id": 1, "campus_name": 1},
                    )
                    if campus_doc:
                        campus_id_row = campus_doc["campus_id"]
                        campus_name_row = campus_doc.get("campus_name", campus_name_row)
                        # still enforce APO scope: can't import to another campus
                        if campus_id_row != campus_id:
                            raise HTTPException(
                                status_code=422,
                                detail=f"Row {idx}: campus '{campus_name_csv}' does not match your APO campus."
                            )
                    # if no doc found, just ignore the CSV campus label and stick to APO campus

                # term: by AY + term_number
                term_doc = await db[COL_TERMS].find_one(
                    {"acad_year_start": acad_year_start, "term_number": term_number},
                    {"_id": 0, "term_id": 1},
                )
                if not term_doc:
                    raise HTTPException(
                        status_code=422,
                        detail=f"Row {idx}: Term {term_number} AY {acad_year_start}-{acad_year_start + 1} not found in terms collection."
                    )
                term_id_row = term_doc["term_id"]

                # program: by program_code
                prog_doc = await db[COL_PROGRAMS].find_one(
                    {"program_code": program_code},
                    {"_id": 0, "program_id": 1, "program_level": 1},
                )
                if not prog_doc:
                    raise HTTPException(
                        status_code=422,
                        detail=f"Row {idx}: program code '{program_code}' not found in programs collection."
                    )
                program_id_row = prog_doc["program_id"]

                # optional: check program level consistency
                lvl_from_csv  = level_code(program_level_lbl) if program_level_lbl else None
                lvl_from_prog = prog_doc.get("program_level")
                level_mismatch = bool(
                    lvl_from_csv and lvl_from_prog and lvl_from_csv != lvl_from_prog
                )

                # batch: reuse existing or create new in batches
                batch_code_norm = _norm_code(batch_label)
                batch_doc = await db[COL_BATCHES].find_one(
                    {
                        "program_id": program_id_row,
                        "campus_id": campus_id_row,
                        "$or": [
                            {"batch_code": batch_code_norm},
                            {"batch_code": {"$regex": f"^{re.escape(batch_label)}$", "$options": "i"}},
                        ],
                    },
                    {"_id": 0, "batch_id": 1, "batch_code": 1, "batch_number": 1},
                )

                if batch_doc:
                    batch_id_row = batch_doc["batch_id"]
                    batch_number = batch_doc.get("batch_number")
                else:
                    m = re.search(r"(\d+)", batch_label)
                    batch_number = int(m.group(1)) if m else None
                    batch_id_row = await _next_seq_id(COL_BATCHES, "batch_id", "BCH", 4)
                    await db[COL_BATCHES].insert_one(
                        {
                            "batch_id": batch_id_row,
                            "batch_code": batch_code_norm or batch_label,
                            "batch_number": batch_number,
                            "program_id": program_id_row,
                            "campus_id": campus_id_row,
                            "created_at": now(),
                            "updated_at": now(),
                        }
                    )

                # collect course codes from all non-meta columns (Course 1, Course 2, ...)
                course_codes: List[str] = []
                for col_name, value in row.items():
                    if not isinstance(col_name, str):
                        continue
                    if col_name.lower() in meta_keys_lower:
                        continue
                    if value is None:
                        continue
                    s_val = str(value).strip()
                    if not s_val:
                        continue
                    # allow comma-separated course codes in a single cell
                    for part in s_val.split(","):
                        code = _norm_code(part)
                        if code:
                            course_codes.append(code)

                if not course_codes:
                    raise HTTPException(status_code=422, detail=f"Row {idx}: no course codes found.")

                # map course_code -> courses.course_id
                course_ids: List[str] = []
                missing_codes: List[str] = []
                for c_code in course_codes:
                    c_doc = await db[COL_COURSES].find_one(
                        {"$or": [{"course_code": c_code}, {"course_code.0": c_code}]},
                        {"_id": 0, "course_id": 1},
                    )
                    if not c_doc:
                        missing_codes.append(c_code)
                    else:
                        cid = c_doc["course_id"]
                        if cid not in course_ids:
                            course_ids.append(cid)

                if missing_codes:
                    raise HTTPException(
                        status_code=422,
                        detail=f"Row {idx}: course code(s) not found: {', '.join(missing_codes)}."
                    )

                # curriculum: upsert per (term, campus, program, batch)
                cur_doc = await db[COL_CURRICULUM].find_one(
                    {
                        "term_id": term_id_row,
                        "campus_id": campus_id_row,
                        "program_id": program_id_row,
                        "batch_id": batch_id_row,
                    }
                )

                if not cur_doc:
                    cur_doc = {
                        "curriculum_id": _id("CURR"),
                        "term_id": term_id_row,
                        "campus_id": campus_id_row,
                        "program_id": program_id_row,
                        "batch_id": batch_id_row,
                        "course_list": course_ids,
                        "created_at": now(),
                        "updated_at": now(),
                    }
                    await db[COL_CURRICULUM].insert_one(cur_doc)
                    added_codes = course_codes
                else:
                    existing_ids = ensure_list(cur_doc.get("course_list"))
                    new_ids = [cid for cid in course_ids if cid not in existing_ids]
                    if new_ids:
                        await db[COL_CURRICULUM].update_one(
                            {"_id": cur_doc["_id"]},
                            {
                                "$set": {
                                    "course_list": existing_ids + new_ids,
                                    "updated_at": now(),
                                }
                            },
                        )
                    added_codes = [
                        course_codes[i]
                        for i, cid in enumerate(course_ids)
                        if cid in new_ids
                    ]

                results.append(
                    {
                        "row": idx,
                        "term_id": term_id_row,
                        "program_id": program_id_row,
                        "batch_id": batch_id_row,
                        "campus_id": campus_id_row,
                        "added_course_codes": added_codes,
                        "level_mismatch": level_mismatch,
                    }
                )

            except HTTPException as e:
                errors.append({"row": idx, "detail": e.detail})
            except Exception as e:
                errors.append({"row": idx, "detail": str(e)})

        return {
            "ok": len(errors) == 0,
            "imported_rows": len(results),
            "rows": results,
            "errors": errors,
        }
    
    if action in ("courseCatalog", "search_catalog"):
        # inputs
        q_raw = (payload or {}).get("q") or ""
        req_limit = int((payload or {}).get("limit", 500))
        limit = max(1, min(req_limit, 1000))  # clamp

        body = payload or {}
        department_id = body.get("department_id") or body.get("departmentId") or None
        # accept either program_level or level from the UI
        program_level = body.get("program_level") or body.get("level") or None  # 'UGS'/'GSM' or 'Undergraduate'/'Graduate'

        # base filter
        flt: Dict[str, Any] = {}
        if department_id:
            flt["department_id"] = department_id
        if program_level:
            flt["program_level"] = level_code(program_level)  # normalize UGS/GSM

        # tokenized query: "CCINF 1" -> regex "CCINF.*1" (case-insensitive)
        tokens = [t for t in re.split(r"\s+", q_raw.strip()) if t]
        if tokens:
            pattern = ".*".join(re.escape(t) for t in tokens)
            rx = {"$regex": pattern, "$options": "i"}
            flt["$or"] = [
                {"course_id": rx},       # allow searching by id (used by plan-review fallbacks)
                {"course_code": rx},     # string form
                {"course_code.0": rx},   # array[0] form
                {"course_title": rx},
            ]

        proj = {
            "_id": 0,
            "course_id": 1,
            "course_code": 1,
            "course_title": 1,
            "department_id": 1,
            "program_level": 1,
            "units": 1,
            "type_of_course": 1,
        }

        # fetch a wider pool, then sort by relevance locally
        pool_cap = min(limit * 5, 2000)
        raw: List[Dict[str, Any]] = []
        cursor = db[COL_COURSES].find(flt, proj).limit(pool_cap)
        async for r in cursor:
            r["course_code"] = _code_str(r.get("course_code"))
            raw.append(r)

        # relevance scoring
        q_join = "".join(tokens).upper() if tokens else ""
        toksU = [t.upper() for t in tokens]

        def contains_in_order(text: str, toks: List[str]) -> bool:
            if not toks:
                return False
            T = (text or "").upper()
            i = 0
            for t in toks:
                j = T.find(t, i)
                if j < 0:
                    return False
                i = j + len(t)
            return True

        def score(row: Dict[str, Any]):
            code = (row.get("course_code") or "").upper()
            title = (row.get("course_title") or "").upper()

            # 0 = best: code starts with query (joined tokens)
            s0 = 0 if (q_join and code.startswith(q_join)) else 1

            # then: tokens appear in order in code, else in title, else none
            if contains_in_order(code, toksU):
                s1 = 0
            elif contains_in_order(title, toksU):
                s1 = 1
            else:
                s1 = 2

            # final tiebreakers: shorter code first, then lexicographic
            return (s0, s1, len(code), code)

        raw.sort(key=score)
        return {"ok": True, "results": raw[:limit]}
    if action == "catalog.create":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload.")

        # Required fields
        course_code = _norm_code((payload.get("course_code") or ""))
        course_title = (payload.get("course_title") or "").strip()
        department_id = (payload.get("department_id") or "").strip()
        program_level_in = payload.get("program_level")  # accepts UG/GS/UGS/GSM or labels
        if not (course_code and course_title and department_id and program_level_in):
            raise HTTPException(
                status_code=422,
                detail="course_code, course_title, department_id, and program_level are required."
            )

        # Validate department exists (optional but safer)
        dep_exists = await db[COL_DEPARTMENTS].find_one({"department_id": department_id}, {"_id": 1})
        if not dep_exists:
            raise HTTPException(status_code=422, detail="department_id not found.")

        # Normalize level and type
        program_level = level_code(program_level_in)  # -> "UGS" or "GSM"
        toc_raw = payload.get("type_of_course")
        toc_norm = canonical_course_type(toc_raw)
        # Store human-facing casing for 'Elective Course'
        if toc_norm == "ELECTIVE COURSE":
            type_of_course = "Elective Course"
        elif toc_norm == "ELECTIVE":
            type_of_course = "Elective"
        elif toc_norm == "GE":
            type_of_course = "GE"
        elif toc_norm == "SHS":
            type_of_course = "SHS"
        elif toc_norm in {"MAJOR", "FOUNDATION", "COS"}:
            type_of_course = toc_norm
        else:
            type_of_course = (toc_raw or "")  # leave as-is if unknown; you can also force "".

        # Units (optional)
        units = None
        if "units" in payload and payload.get("units") not in (None, ""):
            try:
                units = float(payload.get("units"))
            except Exception:
                raise HTTPException(status_code=422, detail="units must be a number.")

        # Capacity for planning defaults — we use 'max_enrollee' in this codebase
        max_enrollee = payload.get("max_enrollee", payload.get("capacity"))
        if max_enrollee in (None, ""):
            max_enrollee = DEFAULT_CAP
        try:
            max_enrollee = int(max_enrollee)
            if max_enrollee < 0:
                raise ValueError()
        except Exception:
            raise HTTPException(status_code=422, detail="max_enrollee/capacity must be a non-negative integer.")

        # Optional description
        description = (payload.get("description") or "").strip()

        # Deduplicate by course_code (string or array[0])
        dup = await db[COL_COURSES].find_one(
            {"$or": [{"course_code": course_code}, {"course_code.0": course_code}]},
            {"_id": 1}
        )
        if dup:
            raise HTTPException(status_code=409, detail="Course with the same course_code already exists.")

        # Generate a new course_id (sequential CRS0001... if available)
        try:
            course_id = await _next_course_id()
        except Exception:
            # Fall back to timestamp style if sequence fails
            course_id = _id("CRS")

        # Build a full doc with defaults for missing fields
        doc = _build_full_course_document(
            {
                "course_code": course_code,            # string -> will be stored as ["CODE"]
                "course_title": course_title,
                "department_id": department_id,
                "program_level": program_level_in,     # accept label or code; builder normalizes
                "type_of_course": payload.get("type_of_course"),
                "units": units,
                "max_enrollee": max_enrollee,
                "description": description,
                # optional inputs if your UI ever sends them:
                "min_enrollee": payload.get("min_enrollee"),
                "room_type": payload.get("room_type"),
                "syllabus": payload.get("syllabus"),
                "course_coordinator": payload.get("course_coordinator"),
                "prerequisites": payload.get("prerequisites"),
                "teaching_team": payload.get("teaching_team"),
            },
            course_id=course_id,
        )

        await db[COL_COURSES].insert_one(doc)
        return {"ok": True, "course": _clean_mongo_doc(doc)}

    if action == "forward":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload.")
        to = (payload.get("to") or "").strip()
        if not to:
            raise HTTPException(status_code=400, detail="'to' is required.")
        oid = _id("OUT-")
        await db[COL_OUTBOX].insert_one({
            "outbox_id": oid, "to": to,
            "subject": (payload.get("subject") or "").strip(),
            "message": (payload.get("message") or "").strip(),
            "attachment_html": (payload.get("attachment_html") or "").strip(),
            "term_id": term_id, "campus_id": campus_id,
            "created_at": now(), "status": "queued",
        })
        return {"ok": True, "queued": True, "outbox_id": oid}

    if action == "curriculumAddCourse":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload.")
        pid = (payload.get("program_id") or "").strip()
        bid = (payload.get("batch_id") or "").strip()
        course_id = (payload.get("course_id") or "").strip()
        if not pid or not bid:
            raise HTTPException(status_code=422, detail="program_id and batch_id are required.")

        if not course_id and payload.get("new_course"):
            nc = payload["new_course"]
            code = _norm_code(nc.get("course_code"))
            title = (nc.get("course_title") or "").strip()
            dep = (nc.get("department_id") or "").strip()
            lvl_in = nc.get("program_level")
            if not (code and title and dep and lvl_in):
                raise HTTPException(status_code=422, detail="new_course requires course_code, course_title, department_id, program_level.")

            cid = await _next_course_id() if "_parse_course_seq" in globals() else _id("CRS")

            doc = _build_full_course_document(
                {
                    "course_code": code,                       # will be saved as [code]
                    "course_title": title,
                    "department_id": dep,
                    "program_level": lvl_in,                   # builder normalizes to UGS/GSM
                    "type_of_course": nc.get("type_of_course"),
                    "units": nc.get("units"),
                    "min_enrollee": nc.get("min_enrollee"),
                    "max_enrollee": nc.get("max_enrollee", nc.get("capacity")),
                    "room_type": nc.get("room_type"),
                    "description": nc.get("description"),
                    "syllabus": nc.get("syllabus"),
                    "course_coordinator": nc.get("course_coordinator"),
                    "prerequisites": nc.get("prerequisites"),
                    "teaching_team": nc.get("teaching_team"),
                },
                course_id=cid,
            )

            await db[COL_COURSES].insert_one(doc)
            course_id = cid

        if not course_id:
            raise HTTPException(status_code=422, detail="course_id or new_course must be provided.")

        cur_doc = await db[COL_CURRICULUM].find_one(
            {"term_id": term_id, "campus_id": campus_id, "program_id": pid, "batch_id": bid}
        )
        if not cur_doc:
            await db[COL_CURRICULUM].insert_one({
                "curriculum_id": _id("CURR"),
                "term_id": term_id, "campus_id": campus_id,
                "program_id": pid, "batch_id": bid,
                "course_list": [course_id],
                "created_at": now(), "updated_at": now()
            })
        else:
            await db[COL_CURRICULUM].update_one(
                {"_id": cur_doc["_id"]},
                {"$addToSet": {"course_list": course_id}, "$set": {"updated_at": now()}}
            )
        return {"ok": True, "course_id": course_id}

    if action == "curriculumEditCourse":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload.")

        pid = (payload.get("program_id") or "").strip()
        bid = (payload.get("batch_id") or "").strip()
        # allow either old_course_id OR course_id from the UI
        old_cid = (
            (payload.get("old_course_id") or "")
            or (payload.get("course_id") or "")
        ).strip()
        new_cid = (payload.get("new_course_id") or "").strip()
        upd = payload.get("update_course")

        # ---- CASE 1: EDIT GLOBAL COURSE FIELDS (code/title/units) ----
        if upd:
            if not old_cid:
                raise HTTPException(
                    status_code=422,
                    detail="old_course_id (or course_id) is required when updating a course."
                )

            f: Dict[str, Any] = {}

            # 1) course_code (CAN BE MULTIPLE)
            #    Accepts:
            #      - "CCINF 1"
            #      - "CCINF 1, CCINF 1L"
            #      - ["CCINF 1", "CCINF 1L"]
            if "course_code" in upd:
                raw_codes = upd.get("course_code")

                if isinstance(raw_codes, str) and "," in raw_codes:
                    raw_codes = [
                        part.strip()
                        for part in raw_codes.split(",")
                        if str(part).strip()
                    ]

                codes_list = _as_list(raw_codes)
                if codes_list:
                    f["course_code"] = codes_list

            # 2) course_title
            if "course_title" in upd:
                f["course_title"] = (upd.get("course_title") or "").strip()

            # 3) program_level (optional, still supported)
            if "program_level" in upd and upd.get("program_level"):
                f["program_level"] = level_code(upd.get("program_level"))

            # 4) units
            if "units" in upd:
                units_val = upd.get("units")
                if units_val in (None, ""):
                    f["units"] = None
                else:
                    try:
                        f["units"] = float(units_val)
                    except Exception:
                        # silently ignore invalid units (same behavior as before)
                        pass

            if f:
                res = await db[COL_COURSES].update_one(
                    {"course_id": old_cid},
                    {"$set": {**f, "updated_at": now()}}
                )
                if res.matched_count == 0:
                    raise HTTPException(status_code=404, detail="Course not found.")

            return {"ok": True, "course_id": old_cid}

        # ---- CASE 2: SWAP COURSE IN A SPECIFIC CURRICULUM (old_id -> new_id) ----
        if not (pid and bid and old_cid):
            raise HTTPException(
                status_code=422,
                detail="program_id, batch_id, old_course_id are required when swapping a course in the curriculum."
            )

        cur_doc = await db[COL_CURRICULUM].find_one(
            {
                "term_id": term_id,
                "campus_id": campus_id,
                "program_id": pid,
                "batch_id": bid,
            }
        )
        if not cur_doc:
            raise HTTPException(status_code=404, detail="Curriculum not found.")

        if not new_cid:
            raise HTTPException(
                status_code=422,
                detail="new_course_id or update_course must be provided."
            )

        clist = [c for c in ensure_list(cur_doc.get("course_list")) if c != old_cid]
        clist.append(new_cid)

        await db[COL_CURRICULUM].update_one(
            {"_id": cur_doc["_id"]},
            {"$set": {"course_list": clist, "updated_at": now()}}
        )
        return {"ok": True, "course_id": new_cid}
    
    if action == "curriculumRemoveCourse":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload.")
        pid = (payload.get("program_id") or "").strip()
        bid = (payload.get("batch_id") or "").strip()
        cid = (payload.get("course_id") or "").strip()
        if not (pid and bid and cid):
            raise HTTPException(status_code=422, detail="program_id, batch_id, course_id are required.")
        await db[COL_CURRICULUM].update_one(
            {"term_id": term_id, "campus_id": campus_id, "program_id": pid, "batch_id": bid},
            {"$pull": {"course_list": cid}, "$set": {"updated_at": now()}}
        )
        return {"ok": True, "removed": 1}

    if action == "approvePlan":
        needs_import, pending, preen_hash, cohort_hash = await _pending_changes(
            term_id=term_id, campus_id=campus_id, campus_name=campus.get("campus_name","")
        )
        if needs_import:
            raise HTTPException(status_code=400, detail="Import Pre-Enlistment first.")

        curr = [x async for x in db[COL_CURRICULUM].find(
            {"term_id": term_id, "campus_id": campus_id},
            {"_id": 0, "program_id": 1, "batch_id": 1, "course_list": 1}
        )]

        # batch_id -> batch_number (best effort)
        batch_ids = sorted({(c.get("batch_id") or "").strip() for c in curr if (c.get("batch_id") or "").strip()})
        batch_number_by_id: Dict[str, int] = {}
        if batch_ids:
            async for b in db[COL_BATCHES].find(
                {"batch_id": {"$in": batch_ids}},
                {"_id": 0, "batch_id": 1, "batch_number": 1, "batch_code": 1}
            ):
                bid = (b.get("batch_id") or "").strip()
                if not bid:
                    continue
                batch_number_by_id[bid] = int(_extract_batch_number(b) or 0)

        # course_id -> set of (batch_id, program_id, batch_number)
        course_to_owner_set: Dict[str, set] = {}
        for c in curr:
            pid = (c.get("program_id") or "").strip()
            bid = (c.get("batch_id") or "").strip()
            bn = int(batch_number_by_id.get(bid, 0))
            for cid in ensure_list(c.get("course_list")):
                if cid and pid and bid:
                    course_to_owner_set.setdefault(cid, set()).add((bid, pid, bn))

        # base sections per course = number of distinct owners (batch+program)
        base_by_course: Dict[str, int] = {cid: max(1, len(owners)) for cid, owners in course_to_owner_set.items()}

        async def _choose_creation_prefix(cid: str) -> str:
            lvl = (await db[COL_COURSES].find_one({"course_id": cid}, {"_id":0,"program_level":1}) or {}).get("program_level")
            owners = sorted({pid for (_bid, pid, _bn) in course_to_owner_set.get(cid, set())})
            pname_list: List[str] = []
            if owners:
                async for p in db[COL_PROGRAMS].find({"program_id": {"$in": owners}}, {"_id":0,"program_name":1}):
                    if p.get("program_name"):
                        pname_list.append(p["program_name"])
            any_cbl = any(_is_cbl_program(nm) for nm in pname_list)
            if "laguna" in (campus.get("campus_name","").lower()):
                if level_code(lvl) == "GSM":
                    return "XX"
                return "XC" if any_cbl else "XX"
            return "G" if level_code(lvl) == "GSM" else "S"

        for ch in pending:
            if ch.get("type") == "add_course_to_curriculum":
                cid = ch.get("course_id")
                target = ch.get("target") or {}
                pid = (target.get("program_id") or "").strip()
                bid = (target.get("batch_id") or "").strip()
                if cid and pid and bid:
                    cur_doc = await db[COL_CURRICULUM].find_one({"term_id": term_id, "campus_id": campus_id, "program_id": pid, "batch_id": bid})
                    if not cur_doc:
                        await db[COL_CURRICULUM].insert_one({
                            "curriculum_id": _id("CURR"),
                            "term_id": term_id, "campus_id": campus_id,
                            "program_id": pid, "batch_id": bid,
                            "course_list": [cid],
                            "created_at": now(), "updated_at": now()
                        })
                    else:
                        await db[COL_CURRICULUM].update_one({"_id": cur_doc["_id"]}, {"$addToSet": {"course_list": cid}, "$set": {"updated_at": now()}})

        for ch in pending:
            if ch.get("type") not in {"sections_increase", "sections_decrease"}:
                continue

            cid = (ch.get("course_id") or "").strip()
            if not cid:
                continue

            lvl = (await db[COL_COURSES].find_one({"course_id": cid}, {"_id":0,"program_level":1}) or {}).get("program_level")
            pref_pat = prefix_pattern_for_level(campus.get("campus_name",""), lvl) or prefix_default
            sec_q = {"term_id": term_id, "campus_id": campus_id, "status": {"$ne": "archived"}, "$or": [{"course_id": cid}, {"fulfilled_placeholder_course_id": cid}]}
            if pref_pat:
                sec_q["section_code"] = {"$regex": f"^{pref_pat}", "$options": "i"}
            existing = await db[COL_SECTIONS].count_documents(sec_q)

            base = max(1, int(base_by_course.get(cid, 1)))

            if ch["type"] == "sections_increase":
                by_sections = int(ch.get("by_sections") or 0)
                if by_sections <= 0:
                    by_cap = int(ch.get("by_capacity") or 0)
                    eff_cap = await effective_section_capacity(term_id, campus.get("campus_name",""), cid) or DEFAULT_CAP
                    by_sections = ceil(by_cap / eff_cap) if by_cap > 0 else 0

                need_base = max(0, base - existing)
                if need_base:
                    creation_prefix = await _choose_creation_prefix(cid)
                    owners_for_course = sorted(list(course_to_owner_set.get(cid, set())))
                    await _create_sections(
                        term_id=term_id,
                        campus_id=campus_id,
                        campus_prefix=creation_prefix,
                        course_id=cid,
                        count=need_base,
                        capacity=await effective_section_capacity(term_id, campus.get("campus_name",""), cid),
                        owners=owners_for_course,
                    )
                    existing += need_base

                by_sections = max(0, by_sections - need_base)

                if by_sections:
                    creation_prefix = await _choose_creation_prefix(cid)
                    owners_for_course = sorted(list(course_to_owner_set.get(cid, set())))
                    await _create_sections(
                        term_id=term_id,
                        campus_id=campus_id,
                        campus_prefix=creation_prefix,
                        course_id=cid,
                        count=by_sections,
                        capacity=await effective_section_capacity(term_id, campus.get("campus_name",""), cid),
                        owners=owners_for_course,
                    )

            else:
                by_sections = int(ch.get("by_sections") or 0)
                if by_sections > 0:
                    target = max(base, existing - by_sections)
                else:
                    est = await estimated_demand(term_id, campus_id, cid)
                    eff_cap = await effective_section_capacity(term_id, campus.get("campus_name",""), cid) or DEFAULT_CAP
                    target = max(base, ceil((est["plan"] or 0) / eff_cap) or 1)

                await reduce_sections_if_excess(
                    term_id=term_id, campus_id=campus_id, campus_prefix=pref_pat,
                    course_id=cid, target_count=target
                )

        await db[COL_PLANSTATE].update_one(
            {"term_id": term_id, "campus_id": campus_id},
            {"$set": {"last_preen_hash": preen_hash, "last_cohort_hash": cohort_hash, "approved": True, "updated_at": now()}},
            upsert=True
        )
        return {"ok": True, "applied": len(pending)}

    # ----- GE/SHS EXEMPTION -----
    plan_warning = False
    if action in {"addRow", "editRow", "deleteRow", "restoreRow"}:
        ge_shs_exempt = False
        target_cid = ""

        if action == "addRow":
            placeholder_id = (payload or {}).get("for_placeholder_course_id") or ""
            specific_id    = (payload or {}).get("specific_course_id") or ""
            raw_course_id  = (payload or {}).get("course_id") or ((payload or {}).get("links", {}) or {}).get("course_id") or ""
            target_cid = (specific_id or raw_course_id or placeholder_id).strip()
        else:
            sec_id = (payload or {}).get("section_id") or ""
            sec_doc = await db[COL_SECTIONS].find_one({"section_id": (sec_id or "").strip()}, {"_id": 0, "course_id": 1})
            target_cid = (sec_doc or {}).get("course_id", "")

        if target_cid:
            ctype = await _course_type(target_cid)
            ge_shs_exempt = (ctype in EDIT_FULL)

        if not ge_shs_exempt:
            needs_import, approval_required, _pending, _ph, _ch, _st = await _planning_flags(
                term_id=term_id, campus_prefix=prefix_default, campus_id=campus_id
            )
            if needs_import:
                raise HTTPException(
                    status_code=409,
                    detail={"code": "NEEDS_IMPORT", "message": "Import Pre-Enlistment (count & statistics) for the current term before editing offerings."}
                )
            plan_warning = bool(approval_required)

    if not payload:
        raise HTTPException(status_code=400, detail="Missing payload.")

    hard = await validate_hard_errors(action, payload, term_id)
    if hard:
        raise HTTPException(status_code=422, detail={"ok": False, "errors": hard})

    soft = await validate_soft_conflicts(
        action=action, payload=payload, campus_name=campus.get("campus_name",""), term_id=term_id, campus_id=campus_id
    )

    gating = [v for v in soft if v.get("code") in {"SEAT_DEFICIT"} and action != "deleteRow"]

    if plan_warning:
        soft.append({
            "code": "PLAN_NOT_APPROVED",
            "level": "warning",
            "message": "Planning updates for this term are pending approval. Proceeding will be recorded as an override.",
        })

    if gating and bool((payload or {}).get("auto_override")):
        reason = (payload.get("override_reason") or "Auto-override from UI").strip() or "Auto-override from UI"
        await audit_override(
            user_id=userId,
            action=action,
            reason=reason,
            violations=gating,
            payload=payload,
        )
        gating = []

    if gating and not payload.get("override"):
        _raw_course = (payload.get("course_id") or payload.get("links", {}).get("course_id") or "").strip()
        _spec = (payload.get("specific_course_id") or "").strip()
        preview_cid = _spec or _raw_course
        pv_lvl = await _course_program_level(preview_cid) if preview_cid else None
        pv_pat = prefix_pattern_for_level(campus.get("campus_name",""), pv_lvl) or prefix_default
        pv_prefix = "XX" if pv_pat == "(XX|XC)" else pv_pat

        tok = await issue_override_token(user_id=userId, payload=payload, violations=gating, ttl_sec=300)
        preview = {}
        if action == "addRow":
            add_cap = payload.get("enrollment_cap")
            if add_cap in (None, ""):
                add_cap = await effective_section_capacity(term_id, campus.get("campus_name",""), preview_cid) if preview_cid else DEFAULT_CAP
            preview = {
                "section_code": payload.get("section_code") or (await next_section_code(pv_prefix, term_id, preview_cid) if preview_cid and pv_prefix else ""),
                "enrollment_cap": int(add_cap),
            }
        elif action == "editRow":
            preview = {"section_code": payload.get("section_code") or "", "enrollment_cap": payload.get("enrollment_cap")}
        elif action == "deleteRow":
            preview = {"will_delete": True}

        raise HTTPException(
            status_code=409,
            detail={"ok": False, "conflict": True, "override_token": tok, "violations": gating, "preview_changes": preview}
        )

    if payload.get("override"):
        _reason = (payload.get("override_reason") or "").strip()
        if not _reason:
            raise HTTPException(status_code=422, detail={"ok": False, "errors": [{"code":"OVERRIDE_REASON_REQUIRED","message":"override_reason is required."}]})
        info = await assert_override_token(payload.get("override_token", ""), userId)
        await audit_override(
            user_id=userId, action=action, reason=_reason,
            violations=info.get("violations") or soft, payload=info.get("payload") or payload,
        )

    
    # ---------- RESTORE ROW (Undo/Redo support) ----------
    # The frontend Undo/Redo history relies on this endpoint:
    #   • SOFT delete: section.status="archived"  -> restore by flipping back to "active" (keeps same section_id)
    #   • HARD delete: section removed entirely    -> restore from COL_APO_SECTION_TRASH snapshot (same section_id)
    # This prevents re-adding rows (which can fail due to section_code uniqueness rules).
    if action == "restoreRow":
        section_id = (payload.get("section_id") or "").strip()
        if not section_id:
            raise HTTPException(status_code=400, detail="Missing section_id")

        # 1) Try SOFT restore (archived -> active)
        res = await db[COL_SECTIONS].update_one(
            {"term_id": term_id, "campus_id": campus_id, "section_id": section_id, "status": "archived"},
            {
                "$set": {"status": "active", "updated_at": now()},
                "$unset": {"archived_at": "", "archived_by": "", "archived_reason": "", "archived_note": ""},
            },
        )
        if res.matched_count:
            # Ensure placeholder schedules + faculty assignment exist (forward/cleanup might have removed them)
            try:
                sec_doc = await db[COL_SECTIONS].find_one(
                    {"term_id": term_id, "campus_id": campus_id, "section_id": section_id},
                    {"_id": 0},
                )
                if sec_doc:
                    await _provision_sched_and_assignment_for_new_section(sec_doc)
            except Exception:
                pass
            return {"ok": True, "restored": int(res.modified_count or 1), "mode": "soft", "status": "active"}

        # 2) If the section still exists (already active / not archived), treat as idempotent
        existing = await db[COL_SECTIONS].find_one(
            {"term_id": term_id, "campus_id": campus_id, "section_id": section_id},
            {"_id": 0, "status": 1},
        )
        if existing:
            return {"ok": True, "restored": 0, "mode": "noop", "status": existing.get("status")}

        # 3) Attempt HARD restore from trash snapshot
        trash = await db[COL_APO_SECTION_TRASH].find_one(
            {"term_id": term_id, "campus_id": campus_id, "section_id": section_id},
            {"_id": 0},
        )
        if not trash:
            raise HTTPException(status_code=404, detail="Section not found.")

        sec_doc = dict(trash.get("section") or {})
        scheds = list(trash.get("schedules") or [])
        facs = list(trash.get("faculty_assignments") or [])

        # Sanitize any accidental Mongo _id fields
        sec_doc.pop("_id", None)
        for d in scheds:
            if isinstance(d, dict):
                d.pop("_id", None)
        for d in facs:
            if isinstance(d, dict):
                d.pop("_id", None)

        # Bring the section back as active
        sec_doc["status"] = "active"
        sec_doc["updated_at"] = now()
        sec_doc.pop("archived_at", None)
        sec_doc.pop("archived_by", None)
        sec_doc.pop("archived_reason", None)
        sec_doc.pop("archived_note", None)

        # Recreate section + dependent docs
        await db[COL_SECTIONS].replace_one(
            {"term_id": term_id, "campus_id": campus_id, "section_id": section_id},
            sec_doc,
            upsert=True,
        )

        # Replace schedules/assignments for this section_id (prevents duplicates)
        try:
            await db[COL_SCHEDS].delete_many({"section_id": section_id})
        except Exception:
            pass
        if scheds:
            try:
                await db[COL_SCHEDS].insert_many(scheds, ordered=False)
            except Exception:
                # ignore partial duplicates
                pass

        try:
            await db[COL_FAC_ASSIGN].delete_many({"section_id": section_id})
        except Exception:
            pass
        if facs:
            try:
                await db[COL_FAC_ASSIGN].insert_many(facs, ordered=False)
            except Exception:
                pass

        # Ensure placeholders exist even if snapshot was incomplete
        try:
            await _provision_sched_and_assignment_for_new_section(sec_doc)
        except Exception:
            pass

        # Consume snapshot so redo/undo stays consistent
        try:
            await db[COL_APO_SECTION_TRASH].delete_one(
                {"term_id": term_id, "campus_id": campus_id, "section_id": section_id}
            )
        except Exception:
            pass

        return {"ok": True, "restored": 1, "mode": "hard", "status": "active"}

# ---------- ADD ROW ----------
    if action == "addRow":
        batch_id = (payload.get("batch_id") or "").strip()

        placeholder_id = (payload.get("for_placeholder_course_id") or "").strip()
        specific_id = (payload.get("specific_course_id") or "").strip()
        raw_course_id = (payload.get("course_id") or "").strip()
        if placeholder_id and specific_id:
            target_course_id = specific_id
        else:
            target_course_id = raw_course_id

        ctype_target = await _course_type(target_course_id)
        is_full = ctype_target in EDIT_FULL

        b = await db[COL_BATCHES].find_one({"batch_id": batch_id}, {"_id": 0, "batch_number": 1, "batch_code": 1})
        batch_number = _extract_batch_number(b or {})

        lvl = await _course_program_level(target_course_id)
        prog_id = (payload.get("program_id") or "").strip()
        prog_name = await _program_name(prog_id) if prog_id else None
        chosen_prefix = campus_section_prefix_for_course(campus.get("campus_name",""), lvl, prog_name) or prefix_default

        section_code = (payload.get("section_code") or "").strip() or await next_section_code(chosen_prefix, term_id, target_course_id)

        sid = await _next_seq_id(COL_SECTIONS, "section_id", "SEC", 4)
        cap = payload.get("enrollment_cap")
        if cap in (None, ""):
            cap = await default_capacity_for_course(target_course_id)
        else:
            cap = int(cap)
        remarks = (payload.get("remarks") or "").strip()

        doc = {
            "section_id": sid, "section_code": section_code,
            "course_id": target_course_id, "term_id": term_id,
            "campus_id": campus_id,
            "enrollment_cap": cap, "remarks": remarks,
            "batch_number": batch_number,
            "owner_program_id": (payload.get("program_id") or "").strip(),
            "owner_batch_id": (payload.get("batch_id") or "").strip(),
            "enrolled": None,
            "status": "active",
            "created_at": now(), "updated_at": now(),
        }

        doc.update(_reset_submission_fields())   

        if (payload.get("section_code") or "").strip():
            doc["_code_from_user"] = True

        if placeholder_id:
            doc["fulfilled_placeholder_course_id"] = placeholder_id

        inserted = await safe_insert_section(doc)
        if not inserted:
            raise HTTPException(status_code=409, detail="Could not allocate a unique section code. Try again.")

        # Create the blank schedules + placeholder faculty assignment safely after insert
        await _provision_sched_and_assignment_for_new_section(doc)

        for idx, key in enumerate(["slot1", "slot2"], start=1):
            s = (payload.get(key) or {})
            # sanitize (treat any TBA text as empty)
            day_raw = s.get("day")
            day = normalize_day(day_raw) if day_raw else ""
            beg, end = (s.get("start_time") or "").strip(), (s.get("end_time") or "").strip()
            rid = (s.get("room_id") or "").strip()
            rtype = (s.get("room_type") or "").strip()

            # normalize away any TBA-like values
            if _is_tba(rid) or rid == "— TBA —":
                rid = ""
            if _is_tba(day) or _is_tba(beg) or _is_tba(end):
                day = beg = end = ""

            has_time = bool(day and beg and end)

            if is_full:
                if rid and not has_time:
                    raise HTTPException(status_code=422, detail={"ok": False, "errors": [
                        {"code": "ROOM_REQUIRES_TIME", "message": f"{key}: room requires day/start_time/end_time."}
                    ]})
                if has_time or rid:
                    doc = {
                        "schedule_id": _sch_id_from_sec(sid, idx),
                        "section_id": sid,
                        "created_at": now(), "updated_at": now(),
                    }
                    if has_time:
                        doc.update({"day": day, "start_time": beg, "end_time": end})
                    if rid:
                        doc["room_id"] = rid
                        if not rtype:
                            rdoc = await db[COL_ROOMS].find_one({"room_id": rid}, {"_id": 0, "room_type": 1})
                            rtype = (rdoc or {}).get("room_type")
                        if rtype:
                            doc["room_type"] = rtype

                    await db[COL_SCHEDS].insert_one(doc)
            else:
                if rid:
                    if not has_time:
                        raise HTTPException(status_code=422, detail={"ok": False, "errors": [
                            {"code": "ROOM_REQUIRES_TIME", "message": f"{key}: room requires day/start_time/end_time."}
                        ]})
                    await db[COL_SCHEDS].insert_one({
                        "schedule_id": _sch_id_from_sec(sid, idx),
                        "section_id": sid,
                        "day": day, "start_time": beg, "end_time": end,
                        "room_id": rid, "room_type": rtype,
                        "created_at": now(), "updated_at": now(),
                    })

        if is_full:
            want_faculty = (
                ("faculty_user_id" in payload) or
                ("faculty_id" in payload) or
                ("faculty_name" in payload) or
                ("faculty" in payload and isinstance(payload.get("faculty"), dict) and payload["faculty"].get("faculty_name"))
            )
            if want_faculty:
                uid = (payload.get("faculty_user_id") or "").strip()
                fid = (payload.get("faculty_id") or "").strip()
                fname = (
                    (payload.get("faculty_name") or "") or
                    ((payload.get("faculty") or {}).get("faculty_name") or "")
                ).strip()
                if not uid and not fid and fname:
                    resolved_uid, resolved_fid = await _resolve_or_create_faculty_by_name(fname)
                    uid, fid = resolved_uid or "", resolved_fid or ""
                if uid or fid:
                    fas_id = await _next_seq_id(COL_FAC_ASSIGN, "faculty_assignment_id", "FAS", 4)
                    asg_id = await _next_seq_id(COL_FAC_ASSIGN, "assignment_id", "ASG", 4)
                    await db[COL_FAC_ASSIGN].update_one(
                        {"section_id": sid},  # do NOT include term_id so legacy rows match
                        {"$set": {
                            "user_id": uid or None,
                            "faculty_id": fid or None,
                            "is_archived": False,
                            "updated_at": now()
                        },
                        "$setOnInsert": {
                            "assignment_id": asg_id,                  # <- legacy field name
                            "load_id": (payload.get("load_id") or None),  # <- optional if you send it
                            "section_id": sid,
                            "created_at": now()
                        }},
                        upsert=True
                    )

        return {"ok": True, "section_id": sid, "warnings": [v for v in soft if v.get("code") not in {"SEAT_DEFICIT"}]}

    # ---------- EDIT ROW ----------
    if action == "editRow":
        section_id = (payload.get("section_id") or "").strip()

        # Track room assignment changes (to notify both OM + APO).
        room_changes: List[Dict[str, Any]] = []

        cid_for_edit = (payload.get("course_id") or "").strip()
        if not cid_for_edit:
            sec_doc = await db[COL_SECTIONS].find_one({"section_id": section_id}, {"_id": 0, "course_id": 1})
            cid_for_edit = (sec_doc or {}).get("course_id", "")
        ctype = (await _course_type(cid_for_edit))
        is_full = ctype in EDIT_FULL

        upd_course = payload.get("update_course") or {}
        course_set: Dict[str, Any] = {}
        if "course_code" in upd_course:
            cc = (upd_course.get("course_code") or "").strip()
            if cc:
                course_set["course_code"] = _norm_code(cc)
        if "course_title" in upd_course:
            ct = (upd_course.get("course_title") or "").strip()
            if ct:
                course_set["course_title"] = ct
        if course_set:
            course_set["updated_at"] = now()
            await db[COL_COURSES].update_one({"course_id": cid_for_edit}, {"$set": course_set})

        sec_updates: Dict[str, Any] = {}
        if "section_code" in payload:
            sec_updates["section_code"] = (payload.get("section_code") or "").strip()
        if "enrollment_cap" in payload:
            cap = payload.get("enrollment_cap")
            sec_updates["enrollment_cap"] = int(cap) if cap not in (None, "") else None
        if "remarks" in payload:
            sec_updates["remarks"] = (payload.get("remarks") or "").strip()

        _new_specific    = (payload.get("specific_course_id") or "").strip()
        _new_placeholder = (payload.get("for_placeholder_course_id") or "").strip()
        if _new_specific:
            sec_updates["course_id"] = _new_specific
        if _new_placeholder:
            sec_updates["fulfilled_placeholder_course_id"] = _new_placeholder
        if sec_updates:
            sec_updates["updated_at"] = now()

            sec_updates.update(_reset_submission_fields()) 

            try:
                await db[COL_SECTIONS].update_one({"section_id": section_id}, {"$set": sec_updates})

                # Keep OM's load-assignment snapshot in sync for capacity edits (rooms are live via schedules).
                # OM table reads sections_submitted.enrollment_cap, so update it immediately when APO edits capacity.
                if 'enrollment_cap' in sec_updates:
                    try:
                        q = {'term_id': term_id, 'section_id': section_id}
                        if campus_id:
                            q['campus_id'] = campus_id
                        await db[COL_SECTIONS_SUBMITTED].update_one(
                            q,
                            {'$set': {'enrollment_cap': sec_updates.get('enrollment_cap'), 'updated_at': now()}},
                        )
                    except Exception:
                        pass

            except DuplicateKeyError:
                raise HTTPException(status_code=409, detail={"ok": False, "errors": [
                    {"code": "SECTION_CODE_DUP", "message": "Section code already in use for this course and term."}
                ]})

        for idx, key in enumerate(["slot1", "slot2"], start=1):
            s = payload.get(key)
            if s is None:
                continue
            existing = await db[COL_SCHEDS].find_one(
                {"section_id": section_id, "schedule_id": _sch_id_from_sec(section_id, idx)}
            )

            prev_room_id = (existing or {}).get("room_id")
            prev_room_id = (str(prev_room_id).strip() if prev_room_id is not None else "")
            # sanitize incoming values (treat any TBA text as empty)
            rid = (s.get("room_id") or "").strip()
            rtype = (s.get("room_type") or "").strip()
            day = (s.get("day") or "").strip() if is_full else ""
            beg = (s.get("start_time") or "").strip() if is_full else ""
            end = (s.get("end_time") or "").strip() if is_full else ""

            if _is_tba(rid) or rid == "— TBA —":
                rid = ""
            if _is_tba(day) or _is_tba(beg) or _is_tba(end):
                day = beg = end = ""

            has_time_now = bool(day and beg and end)
            existing_has_time = bool(existing and existing.get("day") and existing.get("start_time") and existing.get("end_time"))
            payload_has_any_time_key = is_full and any(k in s for k in ("day", "start_time", "end_time"))

            if rid:
                if not (has_time_now or existing_has_time):
                    raise HTTPException(status_code=422, detail={"ok": False, "errors": [
                        {"code": "ROOM_REQUIRES_TIME", "message": f"{key}: room requires day/start_time/end_time."}
                    ]})

            if existing:
                # If user cleared time and room, keep a blank placeholder doc — don't delete.
                if is_full and payload_has_any_time_key and (not has_time_now) and (rid == ""):
                    await db[COL_SCHEDS].update_one(
                        {"_id": existing["_id"]},
                        {"$unset": {"day": "", "start_time": "", "end_time": "", "room_id": ""},
                        "$set": {"updated_at": now()}}
                    )
                    continue

                # Build updates
                set_fields = {"updated_at": now()}
                unset_fields = {}

            if "room_id" in s:
                if rid:
                    set_fields["room_id"] = rid
                    # Also persist room_number for display (robust even if room cache/filtering changes)
                    # and auto-fill room_type if UI didn't send one (or sent empty)
                    rdoc = await db[COL_ROOMS].find_one({"room_id": rid}, {"_id": 0, "room_type": 1, "room_number": 1})
                    if rdoc and (rdoc.get("room_number") or "").strip():
                        set_fields["room_number"] = (rdoc.get("room_number") or "").strip()
                    if not s.get("room_type") and rdoc and (rdoc.get("room_type") or "").strip():
                        set_fields["room_type"] = (rdoc.get("room_type") or "").strip()
                else:
                    unset_fields["room_id"] = ""
                    unset_fields["room_type"] = ""
                    unset_fields["room_number"] = ""


                if "room_type" in s:
                    if rtype:
                        set_fields["room_type"] = rtype
                    else:
                        unset_fields["room_type"] = ""

                if is_full and payload_has_any_time_key:
                    if has_time_now:
                        set_fields.update({"day": day, "start_time": beg, "end_time": end})
                    else:
                        unset_fields.update({"day": "", "start_time": "", "end_time": ""})

                update_doc = {"$set": set_fields}
                if unset_fields:
                    update_doc["$unset"] = unset_fields
                await db[COL_SCHEDS].update_one({"_id": existing["_id"]}, update_doc)

                # Record room change for notifications (only when the payload explicitly touched room_id)
                if "room_id" in s:
                    new_room_id = rid
                    if (prev_room_id or "") != (new_room_id or ""):
                        room_changes.append({
                            "slot": idx,
                            "schedule_id": _sch_id_from_sec(section_id, idx),
                            "day": day or (existing or {}).get("day") or "",
                            "start_time": beg or (existing or {}).get("start_time") or "",
                            "end_time": end or (existing or {}).get("end_time") or "",
                            "from": prev_room_id or "",
                            "to": new_room_id or "",
                        })

            else:
                # no existing schedule doc for this slot
                if rid or has_time_now:
                    doc = {
                        "schedule_id": _sch_id_from_sec(section_id, idx),
                        "section_id": section_id,
                        "created_at": now(), "updated_at": now(),
                    }
                    if has_time_now:
                        doc.update({"day": day, "start_time": beg, "end_time": end})
                    if rid:
                        doc["room_id"] = rid
                        if not rtype:
                            rdoc = await db[COL_ROOMS].find_one({"room_id": rid}, {"_id": 0, "room_type": 1})
                            rtype = (rdoc or {}).get("room_type")
                        if rtype:
                            doc["room_type"] = rtype

                    await db[COL_SCHEDS].insert_one(doc)

                    # Room set on newly-created schedule doc
                    if "room_id" in s:
                        new_room_id = rid
                        if (prev_room_id or "") != (new_room_id or ""):
                            room_changes.append({
                                "slot": idx,
                                "schedule_id": _sch_id_from_sec(section_id, idx),
                                "day": day or "",
                                "start_time": beg or "",
                                "end_time": end or "",
                                "from": prev_room_id or "",
                                "to": new_room_id or "",
                            })

        # --- Notifications for room assignment changes ---
        # Requirement: BOTH OM and APO should receive notifications (in-app + Gmail) for updates.
        if room_changes:
            try:
                # Resolve section + course context
                sec = await db[COL_SECTIONS].find_one(
                    {"section_id": section_id},
                    {"_id": 0, "course_id": 1, "section_code": 1, "campus_id": 1},
                ) or {}
                cid = str(sec.get("course_id") or "").strip()
                scode = str(sec.get("section_code") or "").strip() or (payload.get("section_code") or "")

                course = await db[COL_COURSES].find_one(
                    {"course_id": cid},
                    {"_id": 0, "course_code": 1, "department_id": 1},
                ) or {}
                cc = course.get("course_code")
                if isinstance(cc, list):
                    cc = cc[0] if cc else ""
                course_code = str(cc or "").strip() or cid
                dept_id = str(course.get("department_id") or "").strip()

                campus_name = (campus.get("campus_name") or str(campus_id) or "").strip()

                def _fmt_hhmm(v: Any) -> str:
                    s = str(v or "").strip()
                    s = re.sub(r"[^\d]", "", s)
                    if len(s) == 3:
                        s = "0" + s
                    return f"{s[:2]}:{s[2:]}" if len(s) == 4 else ""

                async def _room_label(rid: str) -> str:
                    rid = (rid or "").strip()
                    if not rid:
                        return "TBA"
                    rdoc = await db[COL_ROOMS].find_one({"room_id": rid}, {"_id": 0, "room_number": 1})
                    return str((rdoc or {}).get("room_number") or rid).strip() or rid

                lines: List[str] = []
                for ch in room_changes[:2]:
                    d = str(ch.get("day") or "").strip()
                    st = _fmt_hhmm(ch.get("start_time"))
                    et = _fmt_hhmm(ch.get("end_time"))
                    old_lbl = await _room_label(str(ch.get("from") or ""))
                    new_lbl = await _room_label(str(ch.get("to") or ""))
                    when = ""
                    if d and st and et:
                        when = f"{d} {st}-{et}"
                    elif d:
                        when = d
                    if when:
                        lines.append(f"{when}: {old_lbl} → {new_lbl}")
                    else:
                        lines.append(f"Slot {int(ch.get('slot') or 0)}: {old_lbl} → {new_lbl}")

                title = "Room Assignment Updated"
                details = (
                    f"Room assignment updated for {course_code} – {scode} ({campus_name}).\n" +
                    "\n".join(lines)
                )

                parts = []
                for c in room_changes:
                    parts.append(f"{c.get('schedule_id')}|{c.get('from')}|{c.get('to')}")
                dedupe_key = f"room_assigned::{term_id}::{section_id}::" + ";".join(parts)
                meta = {
                    "kind": "apo_room_assignment_updated",
                    "term_id": term_id,
                    "campus_id": campus_id,
                    "section_id": section_id,
                    "course_id": cid,
                    "course_code": course_code,
                    "section_code": scode,
                    "changes": room_changes,
                    "dedupe_key": dedupe_key,
                    "route": "/om/load-assignment",
                }

                # Notify OM + GS Coordinator for the department (best-effort)
                if dept_id:
                    recipients = await _om_and_gs_user_ids_for_department_id(dept_id, campus_id, db)
                else:
                    recipients = await _om_and_gs_user_ids_for_campus(campus_id, db)

                for uid in recipients:
                    try:
                        hit = await db["notifications"].find_one(
                            {"user_id": uid, "meta.dedupe_key": dedupe_key},
                            {"_id": 1},
                        )
                        if hit:
                            continue
                        await create_notification(
                            user_id=uid,
                            title=title,
                            details=details,
                            meta=meta,
                            send_email=True,
                            email_from_user_id=userId,
                        )
                    except Exception:
                        continue

                # Notify APO (self) as confirmation
                try:
                    hit2 = await db["notifications"].find_one(
                        {"user_id": userId, "meta.dedupe_key": dedupe_key},
                        {"_id": 1},
                    )
                    if not hit2:
                        await create_notification(
                            user_id=userId,
                            title=title,
                            details=details,
                            meta={**meta, "route": "/apo/courseofferings"},
                            send_email=True,
                            email_from_user_id=userId,
                        )
                except Exception:
                    pass

                # Notify Faculty assigned to this section (best-effort)
                # Requirement: FACULTY must receive appropriate notifications (in-app + Gmail)
                # whenever APO allocates/changes/clears a room.
                try:
                    fac_user_ids: set[str] = set()
                    async for asg in db[COL_FAC_ASSIGN].find(
                        {"section_id": section_id, "is_archived": {"$ne": True}},
                        {"_id": 0, "user_id": 1, "faculty_id": 1},
                    ):
                        uid = str(asg.get("user_id") or "").strip()
                        fid = str(asg.get("faculty_id") or "").strip()
                        if uid:
                            fac_user_ids.add(uid)
                            continue
                        if fid:
                            fp = await db[COL_FAC_PROFILES].find_one(
                                {"faculty_id": fid},
                                {"_id": 0, "user_id": 1},
                            ) or {}
                            u2 = str(fp.get("user_id") or "").strip()
                            if u2:
                                fac_user_ids.add(u2)

                    # Send notifications if any faculty recipients exist
                    for fuid in sorted(list(fac_user_ids)):
                        try:
                            hitf = await db["notifications"].find_one(
                                {"user_id": fuid, "meta.dedupe_key": dedupe_key},
                                {"_id": 1},
                            )
                            if hitf:
                                continue
                            await create_notification(
                                user_id=fuid,
                                title=title,
                                details=details,
                                meta={**meta, "route": "/faculty/overview"},
                                send_email=True,
                                email_from_user_id=userId,
                            )
                        except Exception:
                            continue
                except Exception:
                    pass
            except Exception:
                pass

        want_faculty_change = (
            ("faculty_user_id" in payload) or
            ("faculty_id" in payload) or
            ("faculty_name" in payload) or
            ("faculty" in payload and isinstance(payload.get("faculty"), dict) and payload["faculty"].get("faculty_name")) or
            ("update" in payload and isinstance(payload.get("update"), dict) and payload["update"].get("faculty_name"))
        )

        if is_full and want_faculty_change:
            uid = (payload.get("faculty_user_id") or "").strip()
            fid = (payload.get("faculty_id") or "").strip()
            fname = (
                (payload.get("faculty_name") or "") or
                ((payload.get("faculty") or {}).get("faculty_name") or "") or
                ((payload.get("update") or {}).get("faculty_name") or "")
            ).strip()

            if not uid and not fid and fname:
                resolved_uid, resolved_fid = await _resolve_or_create_faculty_by_name(fname)
                uid, fid = resolved_uid or "", resolved_fid or ""

            if uid or fid:
                await db[COL_FAC_ASSIGN].update_many(
                    {"section_id": section_id, "is_archived": {"$ne": True}},
                    {"$set": {"is_archived": True, "updated_at": now()}}
                )
                fas_id = await _next_seq_id(COL_FAC_ASSIGN, "faculty_assignment_id", "FAS", 4)
                asg_id = await _next_seq_id(COL_FAC_ASSIGN, "assignment_id", "ASG", 4)
                await db[COL_FAC_ASSIGN].update_one(
                    {"section_id": section_id},  # legacy-compatible
                    {"$set": {
                        "user_id": uid or None,
                        "faculty_id": fid or None,
                        "is_archived": False,
                        "updated_at": now()
                    },
                    "$setOnInsert": {
                        "assignment_id": asg_id,
                        "load_id": (payload.get("load_id") or None),
                        "section_id": section_id,
                        "created_at": now()
                    }},
                    upsert=True
                )

        return {"ok": True, "section_id": section_id, "warnings": [v for v in soft if v.get("code") not in {"SEAT_DEFICIT"}]}

    # ---------- DELETE ROW ----------
    if action == "deleteRow":
        section_id = (payload.get("section_id") or "").strip()
        if not section_id:
            raise HTTPException(400, "Missing section_id")

        # If section was ever submitted (exists in snapshot), DO NOT hard-delete immediately.
        # This prevents OM from losing the section (and its current assignments/schedules) until APO re-submits.
        was_submitted = await db[COL_SECTIONS_SUBMITTED].find_one(
            {"term_id": term_id, "campus_id": campus_id, "section_id": section_id},
            {"_id": 0, "section_id": 1},
        )

        if was_submitted:
            await db[COL_SECTIONS].update_one(
                {"term_id": term_id, "campus_id": campus_id, "section_id": section_id},
                {"$set": {"status": "archived", "archived_at": now(), "archived_by": userId, "updated_at": now()}},
            )
            # IMPORTANT: keep schedules/assignments untouched for now (OM + APO see them live)
            # Snapshot will be refreshed on next Submit for Scheduling and only then the OM will stop seeing it.
            return {"ok": True, "deleted": 1, "mode": "soft"}

        # Never submitted yet: hard delete.
        # To support Undo/Redo, store a snapshot first so the UI can restore the *exact* record later.
        try:
            sec_doc = await db[COL_SECTIONS].find_one(
                {"term_id": term_id, "campus_id": campus_id, "section_id": section_id},
                {"_id": 0},
            )
            scheds = [s async for s in db[COL_SCHEDS].find({"section_id": section_id}, {"_id": 0})]
            facs = [f async for f in db[COL_FAC_ASSIGN].find({"section_id": section_id}, {"_id": 0})]
            if sec_doc:
                await db[COL_APO_SECTION_TRASH].update_one(
                    {"term_id": term_id, "campus_id": campus_id, "section_id": section_id},
                    {"$set": {
                        "term_id": term_id,
                        "campus_id": campus_id,
                        "section_id": section_id,
                        "section": sec_doc,
                        "schedules": scheds,
                        "faculty_assignments": facs,
                        "deleted_at": now(),
                        "deleted_by": userId,
                    }},
                    upsert=True,
                )
        except Exception:
            # Don't block deletion if snapshot fails
            pass

        # Cleanup by section_id (schedule/faculty docs may not store term_id/campus_id)
        await db[COL_SCHEDS].delete_many({"section_id": section_id})
        await db[COL_FAC_ASSIGN].delete_many({"section_id": section_id})
        await db[COL_SECTIONS].delete_one({"term_id": term_id, "campus_id": campus_id, "section_id": section_id})
        return {"ok": True, "deleted": 1, "mode": "hard"}

@router.post("/forward/{userId}")
async def apo_forward_courseofferings_to_scheduling(
    userId: str,
    payload: Dict[str, Any] = Body(...),
):
    # Use the same planning term logic
    planning_term = await _get_planning_term()
    term_id = (planning_term or {}).get("term_id")
    if not term_id:
        raise HTTPException(409, "No planning term found.")

    await _sync_section_status_flags(term_id)

    # APO campus scope -> makes Manila/Laguna independent
    campus_id, _ = await apo_scope(userId)
    if not campus_id:
        raise HTTPException(409, "Unable to resolve APO campus from role_assignments.")

    campus = await campus_meta(campus_id)
    campus_name = (campus or {}).get("campus_name") or ""

    tlabel = term_label(planning_term)

    # Read comment/note from payload
    message = (payload.get("message") or "").strip()

    
    # Determine if this campus has already submitted before (persisted in apo_scheduling_submissions)
    sub_doc = await db[COL_APO_SUBMISSIONS].find_one(
        {"term_id": term_id, "campus_id": campus_id},
        {"_id": 0, "submit_count": 1, "first_submitted_at": 1},
    )

    # Fallback for older DBs: infer from snapshot presence
    seed_first = now()
    submit_count = int((sub_doc or {}).get("submit_count") or 0)
    if not sub_doc:
        prior_snap = await db[COL_SECTIONS_SUBMITTED].find_one(
            {"term_id": term_id, "campus_id": campus_id},
            {"_id": 0, "section_id": 1, "submitted_at": 1},
        )
        if prior_snap:
            submit_count = 1
            seed_first = prior_snap.get("submitted_at") or seed_first

    is_initial = submit_count == 0
    if (not is_initial) and (not message):
        raise HTTPException(422, "Comment is required for updates after initial submission.")

    # Publish: mark sections as submitted for THIS campus only
    ts = now()
    res = await db[COL_SECTIONS].update_many(
        {"term_id": term_id, "campus_id": campus_id, "status": {"$ne": "archived"}},
        {"$set": {
            "submitted_for_scheduling": True,
            "submitted_at": ts,
            "submitted_by": userId,
            "updated_at": ts,
        }},
    )

    # Refresh submitted snapshot so OM sees changes ONLY after submit
    snap_res = await _refresh_submitted_sections_snapshot(term_id=term_id, campus_id=campus_id, db=db)

    # Optional cleanup: if APO previously soft-archived sections, archive their assignments and remove schedules now
    archived_ids = [s.get("section_id") async for s in db[COL_SECTIONS].find(
        {"term_id": term_id, "campus_id": campus_id, "status": "archived"},
        {"_id": 0, "section_id": 1},
    )]
    if archived_ids:
        await db[COL_SCHEDS].delete_many({"section_id": {"$in": archived_ids}})
        await db[COL_FAC_ASSIGN].update_many(
            {"section_id": {"$in": archived_ids}},
            {"$set": {"is_archived": True, "updated_at": now()}},
        )


    # Keep existing outbox behavior (optional but consistent)
    to = (payload.get("to") or "").strip()
    if to:
        oid = _id("OUT-")
        await db[COL_OUTBOX].insert_one({
            "outbox_id": oid,
            "to": to,
            "subject": (payload.get("subject") or "").strip(),
            "message": (payload.get("message") or "").strip(),
            "attachment_html": (payload.get("attachment_html") or "").strip(),
            "term_id": term_id,
            "campus_id": campus_id,
            "created_at": now(),
            "status": "queued",
        })

    # --- NOTIFY OM per department (same style as notify-chair) ---

    # Determine departments included in this campus submission
    dept_pipe = [
        {"$match": {"term_id": term_id, "campus_id": campus_id, "submitted_for_scheduling": True}},
        {"$lookup": {"from": COL_COURSES, "localField": "course_id", "foreignField": "course_id", "as": "course"}},
        {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": False}},
        {"$group": {"_id": "$course.department_id"}},
    ]
    dept_rows = [d async for d in db[COL_SECTIONS].aggregate(dept_pipe)]
    dept_ids = [d.get("_id") for d in dept_rows if d and d.get("_id")]

    created = 0
    notified: List[str] = []

    for dept_id in dept_ids:
        recipients = await _om_and_gs_user_ids_for_department_id(dept_id, campus_id, db)
        dept_name = await _dept_name_by_id(dept_id, db)

        # kind inference: forwarded vs updated (same idea as your notify-chair)
        kind = "apo_offerings_forwarded"
        prior = await db["notifications"].find_one(
            {
                "meta.kind": "apo_offerings_forwarded",
                "meta.term_id": term_id,
                "meta.campus_id": campus_id,
                "meta.department_id": dept_id,
            },
            {"_id": 0, "notif_id": 1},
        )
        if prior:
            kind = "apo_offerings_updated"

        title = "Course Offerings Updated" if kind == "apo_offerings_updated" else "Course Offerings Submitted"

        # show term number + acad year instead of (TERM0015)
        details = (
            f"APO ({campus_name}) "
            f"{'updated' if kind == 'apo_offerings_updated' else 'submitted'} course offerings "
            f"for {dept_name or dept_id} ({tlabel})."
        )
        if message:
            details += f"\n\nNote: {message}"

        meta = {
            "route": "/om/loadassignment",
            "kind": kind,
            "term_id": term_id,         # keep for routing/filters
            "campus_id": campus_id,
            "department_id": dept_id,
            "term_label": tlabel,       # optional (handy for UI later)
        }

        for uid in recipients:
            await create_notification(
                user_id=uid,
                title=title,
                details=details,
                meta=meta,
                send_email=True,
                email_from_user_id=userId,
            )
            created += 1
            notified.append(uid)

    # dedupe notified
    seen = set()
    notified = [x for x in notified if not (x in seen or seen.add(x))]

    
    # Persist submission history (so UI can require notes even if section flags get reset on edits)
    upd = {
        "$set": {
            "term_id": term_id,
            "campus_id": campus_id,
            "last_submitted_at": ts,
            "last_submitted_by": userId,
            "last_note": message,
            "updated_at": ts,
        }
    }
    if sub_doc:
        upd["$inc"] = {"submit_count": 1}
    else:
        upd["$setOnInsert"] = {"first_submitted_at": seed_first, "submit_count": 1}

    await db[COL_APO_SUBMISSIONS].update_one(
        {"term_id": term_id, "campus_id": campus_id},
        upd,
        upsert=True,
    )

    return {
        "ok": True,
        "published": int(getattr(res, "modified_count", 0) or 0),
        "snapshot": snap_res,
        "term_id": term_id,
        "campus_id": campus_id,
        "term_label": tlabel,          # optional
        "notif_created": created,
        "notif_recipients": notified,
    }

    raise HTTPException(status_code=400, detail="Invalid action.")
