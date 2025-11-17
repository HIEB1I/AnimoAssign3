from __future__ import annotations

from datetime import datetime, timedelta
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

router = APIRouter(prefix="/apo", tags=["apo"])

# ------------ collections ------------
COL_TERMS = "terms"
COL_CURRICULUM = "curriculum"
COL_COURSES = "courses"
COL_DEPARTMENTS = "departments"
COL_PROGRAMS = "programs"
COL_BATCHES = "batches"
COL_SECTIONS = "sections"
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

DEFAULT_CAP = 20

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

      - base = result of _ensure_current_term()
               (the term where is_current == True, or the latest term if none is flagged yet)
      - planning = next term in sequence (TERM0015 after TERM0014, etc.)
      - if the next term does not exist, we fall back to the base term
    """
    base = await _ensure_current_term()
    if not base or not base.get("term_id"):
        raise HTTPException(status_code=404, detail="No current term found in terms collection.")

    base_id = base["term_id"]  # e.g., "TERM0014"

    # Compute next term id (TERM0015) from suffix
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

    # If there is no TERM0015 (or next), just fall back to the current term
    if not planning:
        planning = await db[COL_TERMS].find_one(
            {"term_id": base_id},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        ) or {}

    return planning

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
    try:
        await db[COL_SECTIONS].create_index(
            [("term_id", 1), ("fulfilled_placeholder_course_id", 1)],
            name="idx_term_fulfilled_placeholder"
        )
    except Exception:
        pass
    await db[COL_SECTIONS].update_many(
        {"term_id": current_term_id, "status": {"$ne": "active"}},
        {"$set": {"status": "active", "updated_at": now()}}
    )
    await db[COL_SECTIONS].update_many(
        {"term_id": {"$ne": current_term_id}, "status": {"$ne": "inactive"}},
        {"$set": {"status": "inactive", "updated_at": now()}}
    )

def term_label(t: Optional[Dict[str, Any]]) -> str:
    if not t:
        return ""
    n = t.get("term_number")
    ays = t.get("acad_year_start")
    aye = (ays + 1) if isinstance(ays, int) else None
    return f"Term {n} · AY {ays}-{aye}" if (n and ays and aye) else (t.get("term_id") or "")

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
    Import curriculum rows from CSV.

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
            "Course 2": "CCPROG2",
            "Course 3": "ITSTRAG"
          },
          ...
        ],
        "term_id": "TERM0015",
        "campus_name": "Manila"
    }
    """
    rows = payload.get("rows") or []
    term_id = payload.get("term_id")
    campus_name = payload.get("campus_name")

    if not isinstance(rows, list) or not term_id or not campus_name:
        raise HTTPException(
            status_code=400,
            detail="rows, term_id and campus_name are required for import_curriculum_csv",
        )

    # Validate term
    term = await db[COL_TERMS].find_one({"term_id": term_id})
    if not term:
        raise HTTPException(status_code=400, detail=f"Unknown term_id {term_id!r}")

    # Resolve campus_name -> campus_id
    campus = await db["campuses"].find_one(
        {"$or": [{"campus_name": campus_name}, {"campus_id": campus_name}]}
    )
    if not campus:
        raise HTTPException(status_code=400, detail=f"Unknown campus {campus_name!r}")
    campus_id = campus["campus_id"]

    created_batches: List[str] = []
    updated_curricula: List[Dict[str, Any]] = []

    for raw in rows:
        if not raw:
            continue

        # ---- CSV columns ----
        batch_code = (str(raw.get("Batch") or raw.get("batch") or "")).strip()
        program_level = (str(raw.get("Program Level") or raw.get("ProgramLevel") or "")).strip()
        program_code = (str(raw.get("Program") or raw.get("Program Code") or "")).strip()

        # not strictly needed for DB, but read them if you want to log/use later
        term_number_csv = raw.get("Term Number") or raw.get("TermNumber")
        acad_year_csv = raw.get("Academic Year") or raw.get("AY")

        if not batch_code or not program_code:
            # skip incomplete row
            continue

        # 1) Resolve program_id from Program column (e.g., "BSCS-ST")
        program = await db[COL_PROGRAMS].find_one({"program_code": program_code})
        if not program:
            raise HTTPException(
                status_code=400,
                detail=f"Program {program_code!r} not found in programs collection",
            )
        program_id = program["program_id"]

        # 2) Ensure batch exists (CSV "Batch" = batches.batch_code)
        batch = await db[COL_BATCHES].find_one(
            {"batch_code": batch_code, "program_id": program_id}
        )

        if not batch:
            # Generate next batch_id, e.g., BATCH0001, BATCH0002, ...
            last_batch = await db[COL_BATCHES].find(
                {"batch_id": {"$regex": r"^BATCH[0-9]+$"}}
            ).sort("batch_id", -1).limit(1).to_list(1)
            if last_batch:
                last_num = int(last_batch[0]["batch_id"][5:])
            else:
                last_num = 0
            batch_id = f"BATCH{last_num + 1:04d}"

            batch_doc = {
                "batch_id": batch_id,
                "batch_code": batch_code,      # <-- "ID 126"
                "program_id": program_id,
                "intake_term_id": term_id,
                "curriculum_id": None,         # filled after curriculum insert
                "status": "active",
                "created_at": datetime.utcnow(),
                "updated_at": datetime.utcnow(),
            }
            await db[COL_BATCHES].insert_one(batch_doc)
            created_batches.append(batch_id)
        else:
            batch_id = batch["batch_id"]

        # 3) Collect course codes from Course 1, Course 2, ...
        course_codes: List[str] = []
        for key, value in raw.items():
            if key.lower().startswith("course"):
                v = str(value or "").strip()
                if v:
                    course_codes.append(v)

        if not course_codes:
            continue

        # 4) Resolve course_ids using courses.course_code (ARRAY)
        course_docs = await db[COL_COURSES].find(
            {"course_code": {"$in": course_codes}}
        ).to_list(None)

        found_codes = {
            code for doc in course_docs for code in doc.get("course_code", [])
        }
        missing = sorted(set(course_codes) - found_codes)
        if missing:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Unknown course_code(s) in CSV for program {program_code!r}: "
                    + ", ".join(missing)
                ),
            )

        course_ids = [doc["course_id"] for doc in course_docs]

        # 5) Upsert curriculum (one per batch_id + term_id + campus_id)
        existing_cur = await db[COL_CURRICULUM].find_one(
            {"batch_id": batch_id, "term_id": term_id, "campus_id": campus_id}
        )
        if existing_cur:
            curriculum_id = existing_cur["curriculum_id"]
        else:
            last_cur = await db[COL_CURRICULUM].find(
                {"curriculum_id": {"$regex": r"^CUR[0-9]+$"}}
            ).sort("curriculum_id", -1).limit(1).to_list(1)
            if last_cur:
                last_num = int(last_cur[0]["curriculum_id"][3:])
            else:
                last_num = 0
            curriculum_id = f"CUR{last_num + 1:04d}"

        curriculum_doc = {
            "curriculum_id": curriculum_id,
            "batch_id": batch_id,
            "program_id": program_id,
            "term_id": term_id,
            "campus_id": campus_id,
            # *** IMPORTANT: list of course_id strings ***
            "course_list": course_ids,
            "created_at": datetime.utcnow(),
            "updated_at": datetime.utcnow(),
        }

        await db[COL_CURRICULUM].update_one(
            {"curriculum_id": curriculum_id},
            {"$set": curriculum_doc},
            upsert=True,
        )

        # 6) Link batch -> curriculum
        await db[COL_BATCHES].update_one(
            {"batch_id": batch_id},
            {"$set": {"curriculum_id": curriculum_id, "updated_at": datetime.utcnow()}},
        )

        updated_curricula.append(
            {
                "batch_id": batch_id,
                "curriculum_id": curriculum_id,
                "course_count": len(course_ids),
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
    cond: Dict[str, Any] = {"course_id": course_id, "term_id": term_id, "is_archived": {"$ne": True}}
    if campus_id and await db[COL_PREEN].count_documents({**cond, "campus_id": campus_id}) > 0:
        cond["campus_id"] = campus_id
    total = 0
    async for r in db[COL_PREEN].find(cond, {"_id": 0, "preenlistment_count": 1, "count": 1}):
        total += int(r.get("preenlistment_count") or r.get("count") or 0)
    return total

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
        sec_q: Dict[str, Any] = {"term_id": term_id}
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
    q: Dict[str, Any] = {"term_id": term_id, "$or": [{"course_id": course_id}, {"fulfilled_placeholder_course_id": course_id}]}
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
    *, term_id: str, campus_id: str, campus_prefix: str, course_id: str, count: int, capacity: int = DEFAULT_CAP
) -> int:
    made = 0
    for _ in range(max(0, int(count))):
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
        }
        if await safe_insert_section(doc):
            await _provision_sched_and_assignment_for_new_section(doc)
            made += 1
    return made

async def reduce_sections_if_excess(*, term_id: str, campus_prefix: str, course_id: str, target_count: int) -> int:
    q: Dict[str, Any] = {"term_id": term_id, "$or": [{"course_id": course_id}, {"fulfilled_placeholder_course_id": course_id}]}
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

    removable: List[Dict[str, Any]] = []
    for s in secs:
        sid = s["section_id"]
        has_sched = await db[COL_SCHEDS].find_one({"section_id": sid}) is not None
        has_fac = await db[COL_FAC_ASSIGN].find_one({"section_id": sid, "is_archived": {"$ne": True}}) is not None
        if not has_sched and not has_fac:
            removable.append(s)

    to_delete = min(cur_count - target_count, len(removable))
    deleted = 0
    for s in removable[:to_delete]:
        sid = s["section_id"]
        await db[COL_SECTIONS].delete_one({"section_id": sid})
        await db[COL_SCHEDS].delete_many({"section_id": sid})
        await db[COL_FAC_ASSIGN].update_many({"section_id": sid}, {"$set": {"is_archived": True, "updated_at": now()}})
        deleted += 1
    return deleted

# ---------- planning snapshots & diffs ----------
async def _preen_snapshot(term_id: str, campus_id: str) -> Dict[str, int]:
    cond = {"term_id": term_id, "is_archived": {"$ne": True}}
    if await db[COL_PREEN].count_documents({**cond, "campus_id": campus_id}) > 0:
        cond["campus_id"] = campus_id
    out: Dict[str, int] = {}
    async for d in db[COL_PREEN].find(cond, {"_id": 0, "course_id": 1, "preenlistment_count": 1, "count": 1}):
        cid = d.get("course_id") or ""
        out[cid] = out.get(cid, 0) + int(d.get("preenlistment_count") or d.get("count") or 0)
    return out

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
        sec_q: Dict[str, Any] = {"term_id": term_id, "$or": [{"course_id": cid}, {"fulfilled_placeholder_course_id": cid}]}
        pref = (prefix_map.get(cid) or "").strip()
        if pref:
            sec_q["section_code"] = {"$regex": f"^{pref}", "$options": "i"}
        total = 0
        async for s in db[COL_SECTIONS].find(sec_q, {"_id":0, "enrollment_cap":1}):
            total += int(s.get("enrollment_cap") or DEFAULT_CAP)
        out[cid] = total
    return out

async def _section_count(term_id: str, campus_prefix_pattern: str, course_id: str) -> int:
    q: Dict[str, Any] = {"term_id": term_id}
    q["$or"] = [{"course_id": course_id}, {"fulfilled_placeholder_course_id": course_id}]
    if campus_prefix_pattern:
        q["section_code"] = {"$regex": f"^{campus_prefix_pattern}", "$options": "i"}
    return await db[COL_SECTIONS].count_documents(q)

async def _pending_changes(
    *, term_id: str, campus_id: str, campus_name: str
) -> Tuple[bool, List[Dict[str, Any]], str, str]:
    has_preen = await db[COL_PREEN].count_documents({"term_id": term_id, "is_archived": {"$ne": True}}) > 0
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


async def _rooms_available_for_slot(
    campus_id: str,
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
        room_q["capacity"] = min_capacity

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

    # --- 3) BUSY FILTER: exclude rooms already booked in this slot ----------
    # A room is BUSY if there is any section_schedules row with:
    #   - section_id present
    #   - same day (any alias)
    #   - overlapping time [start4,end4)
    conflict_q: Dict[str, Any] = {
        "room_id": {"$in": allowed_ids},
        "section_id": {"$exists": True},
        "day": {"$in": day_aliases(day_full)},
        "start_time": {"$lt": end4},
        "end_time": {"$gt": start4},
    }
    if exclude_schedule_ids:
        conflict_q["schedule_id"] = {"$nin": exclude_schedule_ids}

    busy_room_ids: Set[str] = set()
    async for s in db[COL_SCHEDS].find(
        conflict_q,
        {"_id": 0, "room_id": 1},
    ):
        rid = s.get("room_id")
        if rid:
            busy_room_ids.add(rid)

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
    view: Optional[Literal["curriculum", "offerings"]] = Query("offerings"),
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
        rt_required = (room_type or "").strip() or None
        if not rt_required:
            # prefer the picked schedule’s room_type if we have exactly one slot
            if len(slots) == 1 and slots[0][3]:
                rt_required = slots[0][3]
            elif cid_for_defaults:
                cdoc = await db[COL_COURSES].find_one({"course_id": cid_for_defaults}, {"_id": 0, "room_type": 1})
                rt_required = ((cdoc or {}).get("room_type") or "").strip() or None

        # --- compute available rooms for each inferred slot; union the results
        slot_room_sets: List[Dict[str, Dict[str, Any]]] = []
        for (d, s, e, _rt_from_sched) in slots:
            avail = await _rooms_available_for_slot(
                campus_id=campus_for_rooms,
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
        return {
            "campus": campus,
            "term_id": term_id,
            "term_label": term_label(planning_term), 
            "items": items,
            "course_options_by_program": course_options_by_program,
            "departments": departments
        }

    # ---- Offerings View ----
    room_opts: List[Dict[str, Any]] = [
        {"room_id": "", "room_number": "— TBA —", "capacity": None, "room_type": None},
        {"room_id": "ONLINE", "room_number": "ONLINE", "capacity": None, "room_type": "ONLINE"},
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
        sec_q: Dict[str, Any] = {"term_id": term_id, "$or": [{"course_id": cid}, {"fulfilled_placeholder_course_id": cid}]}
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
            room_number = rmap.get(rid, "")
            if not room_number:
                if rid == "ONLINE":
                    room_number = "ONLINE"
                elif not rid:
                    room_number = "— TBA —"
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
        "addRow", "editRow", "deleteRow", "forward",
        "curriculumAddCourse", "curriculumEditCourse", "curriculumRemoveCourse",
        "approvePlan",
        "courseCatalog", "search_catalog",
        "catalog.create", 
        "curriculumImportCsv", "curriculum.importCsv",
        "import_curriculum_csv"
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
            {"_id":0,"program_id":1,"course_list":1}
        )]
        course_to_programs: Dict[str, set] = {}
        for c in curr:
            pid = c.get("program_id")
            for cid in ensure_list(c.get("course_list")):
                if pid:
                    course_to_programs.setdefault(cid, set()).add(pid)
        base_by_course: Dict[str, int] = {cid: max(1, len(ps)) for cid, ps in course_to_programs.items()}

        async def _choose_creation_prefix(cid: str) -> str:
            lvl = (await db[COL_COURSES].find_one({"course_id": cid}, {"_id":0,"program_level":1}) or {}).get("program_level")
            owners = list(course_to_programs.get(cid, set()))
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
            sec_q = {"term_id": term_id, "$or": [{"course_id": cid}, {"fulfilled_placeholder_course_id": cid}]}
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
                    await _create_sections(
                        term_id=term_id,
                        campus_id=campus_id,
                        campus_prefix=creation_prefix,
                        course_id=cid,
                        count=need_base,
                        capacity=await effective_section_capacity(term_id, campus.get("campus_name",""), cid)
                    )
                    existing += need_base

                by_sections = max(0, by_sections - need_base)

                if by_sections:
                    creation_prefix = await _choose_creation_prefix(cid)
                    await _create_sections(
                        term_id=term_id,
                        campus_id=campus_id,
                        campus_prefix=creation_prefix,
                        course_id=cid,
                        count=by_sections,
                        capacity=await effective_section_capacity(term_id, campus.get("campus_name",""), cid)
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
                    term_id=term_id, campus_prefix=pref_pat,
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
    if action in {"addRow", "editRow", "deleteRow"}:
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

    gating = [v for v in soft if v.get("code") in {"SEAT_DEFICIT"}]

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
            try:
                await db[COL_SECTIONS].update_one({"section_id": section_id}, {"$set": sec_updates})
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
                        # Auto-fill room_type if UI didn't send one (or sent empty)
                        if not s.get("room_type"):
                            rdoc = await db[COL_ROOMS].find_one({"room_id": rid}, {"_id": 0, "room_type": 1})
                            if rdoc and (rdoc.get("room_type") or "").strip():
                                set_fields["room_type"] = (rdoc.get("room_type") or "").strip()
                    else:
                        unset_fields["room_id"] = ""
                        unset_fields["room_type"] = ""


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
        await db[COL_SCHEDS].delete_many({"section_id": section_id})
        await db[COL_FAC_ASSIGN].update_many({"section_id": section_id}, {"$set": {"is_archived": True, "updated_at": now()}})
        await db[COL_SECTIONS].delete_one({"section_id": section_id})
        return {"ok": True, "deleted": 1}

    raise HTTPException(status_code=400, detail="Invalid action.")
