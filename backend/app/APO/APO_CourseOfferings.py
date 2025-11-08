from __future__ import annotations

from datetime import datetime, timedelta
from math import ceil
import re
import json
import hashlib
import secrets
from typing import Any, Dict, List, Optional, Tuple, Literal

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


# --- ELECTIVE SUPPORT ---
def _ctype(v: Optional[str]) -> str:
    return (v or "").strip().upper()

# Placeholder in curriculum (e.g., ITELEC1)
ELECTIVE_PLACEHOLDER = "ELECTIVE"
# Actual, specific courses that can fulfill the elective slot
ELECTIVE_SPECIFIC = "ELECTIVE COURSE"

# --- COURSE TYPE NORMALIZATION (fixes GE not being treated as full-editable) ---
def canonical_course_type(x: Optional[str]) -> str:
    u = _ctype(x)
    # GE synonyms
    if u == "GE" or u == "GE COURSE" or "GENERAL EDUCATION" in u:
        return "GE"
    # SHS synonyms
    if u in {"SHS", "SENIOR HIGH", "SENIOR HIGH SCHOOL"}:
        return "SHS"
    # Elective forms
    if u == "ELECTIVE COURSE":
        return "ELECTIVE COURSE"
    if u == "ELECTIVE":
        return "ELECTIVE"
    # Keep common limited types as-is
    if u in {"MAJOR", "FOUNDATION", "COS"}:
        return u
    return u

# ------------ utils ------------
def now() -> datetime:
    return datetime.utcnow()

def _ts() -> int:
    return int(datetime.utcnow().timestamp() * 1000)

def _id(prefix: str) -> str:
    return f"{prefix}{_ts()}"

def _norm_code(code: Optional[str]) -> str:
    s = (code or "").strip().upper()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"^ID\s*(\d+)$", r"ID \1", s)
    return s

def _code_str(value):
    """Return a safe string for course_code that may be a string, list, or empty."""
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

# If no current term is marked, try to infer and mark one so routes still work.
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

async def _sync_section_status_flags(current_term_id: str) -> None:
    # mark sections of the current term as active
    await db[COL_SECTIONS].update_many(
        {"term_id": current_term_id, "status": {"$ne": "active"}},
        {"$set": {"status": "active", "updated_at": now()}}
    )
    # everything not in the current term becomes inactive
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

# --- NEW: course default capacity from courses.max_enrollee ---
async def default_capacity_for_course(course_id: str) -> int:
    doc = await db[COL_COURSES].find_one({"course_id": course_id}, {"_id": 0, "max_enrollee": 1})
    try:
        v = doc.get("max_enrollee") if doc else None
        return int(v) if v not in (None, "") else DEFAULT_CAP
    except Exception:
        return DEFAULT_CAP

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

async def campus_meta(campus_id: Optional[str]) -> Dict[str, str]:
    if not campus_id:
        return {"campus_id": "", "campus_name": ""}
    c = await db[COL_CAMPUSES].find_one(
        {"campus_id": campus_id}, {"_id": 0, "campus_id": 1, "campus_name": 1}
    )
    return c or {"campus_id": campus_id, "campus_name": ""}

def campus_section_prefix(campus_name: str) -> Optional[str]:
    n = (campus_name or "").lower()
    if "laguna" in n or "biñan" in n or "binan" in n or "canlubang" in n:
        return "XX"
    if "manila" in n or "taft" in n:
        return "S"
    return None

# --- NEW: CBL helpers / prefix selection -------------------

def _is_cbl_program(program_name: Optional[str]) -> bool:
    """True if program name ends with '(CBL)' (case-insensitive, tolerant to spaces)."""
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
    """
    Manila: UG -> 'S', GS -> 'G'
    Laguna: UG (CBL) -> 'XC'; UG (non-CBL) -> 'XX'
    """
    n = (campus_name or "").lower()
    is_laguna = ("laguna" in n) or ("biñan" in n) or ("binan" in n) or ("canlubang" in n)
    is_manila = ("manila" in n) or ("taft" in n)

    norm = level_code(level_or_code)
    is_grad = (norm == "GSM")

    if is_manila:
        return "G" if is_grad else "S"
    if is_laguna:
        if is_grad:
            # If GS ever exists in Laguna (rare), default to 'XX' (can adjust later)
            return "XX"
        return "XC" if _is_cbl_program(program_name) else "XX"
    return None

def prefix_pattern_for_level(campus_name: str, level_or_code: Optional[str]) -> str:
    """
    Pattern for listing/aggregates:
      Manila UG -> '^S', Manila GS -> '^G'
      Laguna UG -> '^(XX|XC)' (include both)
    """
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

# --- NEW: numbering bases and formatting ---
def section_start_base(prefix: str) -> int:
    """Return base 'already-exists' number so next is the first code."""
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

def caps_name(u: Dict[str, Any]) -> str:
    first, last = (u.get("first_name") or "").strip(), (u.get("last_name") or "").strip()
    mid = (u.get("middle_name") or "").strip()
    return f"{last}, {first} {mid}".strip().upper() if mid else f"{last}, {first}".strip().upper()

def _sha1_of(obj: Any) -> str:
    b = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha1(b).hexdigest()

# ------------ Level mapping (labels) ------------
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
    return c  # fallback

# ------------ editing rules (type_of_course) ------------
EDIT_FULL = {"GE", "SHS"}  # full-row edit (faculty, day/time, etc.)
EDIT_LIMITED = {"MAJOR", "FOUNDATION", "ELECTIVE", "COS", "ELECTIVE COURSE"}

# Replace old _course_type with canonicalized version
async def _course_type(course_id: str) -> str:
    """Return canonicalized type_of_course."""
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
    return (x, None)  # unknown, return as-is for display

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
    Try to resolve a free-text name to either a users.user_id (preferred) or faculty_profiles.faculty_id.
    If not found, create a minimal faculty_profile and return (None, new_faculty_id).
    Returns (user_id, faculty_id).
    """
    nm = _parse_person_name(name)
    if not nm:
        return (None, None)

    def _eq_ci(field: str, val: str) -> Dict[str, Any]:
        return {field: {"$regex": f"^{re.escape(val)}$", "$options": "i"}}

    # 1) Try real user
    users_q: Dict[str, Any] = {}
    if nm["first_name"]: users_q.update(_eq_ci("first_name", nm["first_name"]))
    if nm["last_name"]: users_q.update(_eq_ci("last_name", nm["last_name"]))
    if nm["middle_name"]:
        users_q["middle_name"] = {"$regex": f"^{re.escape(nm['middle_name'])}$", "$options": "i"}
    else:
        users_q["$or"] = [{"middle_name": {"$exists": False}}, {"middle_name": ""}]
    u = await db[COL_USERS].find_one(users_q, {"_id": 0, "user_id": 1})
    if u and u.get("user_id"):
        return (u["user_id"], None)

    # 2) Else faculty profile
    fac_q: Dict[str, Any] = {}
    if nm["first_name"]: fac_q.update(_eq_ci("first_name", nm["first_name"]))
    if nm["last_name"]: fac_q.update(_eq_ci("last_name", nm["last_name"]))
    if nm["middle_name"]:
        fac_q["middle_name"] = {"$regex": f"^{re.escape(nm['middle_name'])}$", "$options": "i"}
    else:
        fac_q["$or"] = [{"middle_name": {"$exists": False}}, {"middle_name": ""}]
    fp = await db[COL_FAC_PROFILES].find_one(fac_q, {"_id": 0, "faculty_id": 1, "user_id": 1})
    if fp:
        if fp.get("user_id"):
            return (fp["user_id"], None)
        if fp.get("faculty_id"):
            return (None, fp["faculty_id"])

    # 3) Create minimal faculty profile
    fid = _id("FAC")
    doc = {
        "faculty_id": fid,
        "first_name": nm["first_name"],
        "middle_name": nm["middle_name"],
        "last_name": nm["last_name"],
        "source": "custom",
        "created_at": now(),
        "updated_at": now(),
    }
    await db[COL_FAC_PROFILES].insert_one(doc)
    return (None, fid)

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
            "source": 1,
            "units": 1,
            "type_of_course": 1,  # include type
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
            "source": c.get("source", "DB"),
            "units": c.get("units"),
            "type_of_course": c.get("type_of_course", ""),  # keep raw for UI; backend uses canonical fn
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
    """
    Return stats for a program in a term (campus-agnostic).
    Supports fallback via program_code when only that is present in the stats collection.
    """
    proj = {"_id": 0, "freshman": 1, "sophomore": 1, "junior": 1, "senior": 1, "enrollment": 1}

    # Primary: program_id
    doc = await db[COL_PREEN_STATS].find_one({"term_id": term_id, "program_id": program_id}, proj)
    if doc:
        return doc

    # Fallback: program_code
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
    for _ in range(retries):
        try:
            await db[COL_SECTIONS].insert_one(doc)
            return doc["section_id"]
        except DuplicateKeyError:
            prefix = re.match(r"^[A-Za-z]+", doc["section_code"]).group(0) if doc.get("section_code") else ""
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

    # --- ELECTIVE SUPPORT: accept either (course_id) OR (for_placeholder_course_id + specific_course_id)
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
                    if not sc or _ctype(sc.get("type_of_course")) == ELECTIVE_PLACEHOLDER:
                        err("ELECTIVE_SPECIFIC_INVALID", "specific_course_id must be a non-placeholder course.")

        if action == "editRow":
            if specific_id:
                sc = await db[COL_COURSES].find_one({"course_id": specific_id}, {"_id": 0, "type_of_course": 1})
                if not sc or _ctype(sc.get("type_of_course")) == ELECTIVE_PLACEHOLDER:
                    err("ELECTIVE_SPECIFIC_INVALID", "specific_course_id must be a non-placeholder course.")
            if placeholder_id:
                ph = await db[COL_COURSES].find_one({"course_id": placeholder_id}, {"_id": 0, "type_of_course": 1})
                if not ph or _ctype(ph.get("type_of_course")) != ELECTIVE_PLACEHOLDER:
                    err("ELECTIVE_PLACEHOLDER_INVALID", "for_placeholder_course_id must be 'Elective'.")

        # NEW: a room cannot be set if the slot has no day/time
        for idx, key in enumerate(["slot1", "slot2"], start=1):
            s = (payload.get(key) or {}) if isinstance(payload.get(key), dict) else {}
            rid = (s.get("room_id") or "").strip()
            has_time = bool((s.get("day") or "").strip() and (s.get("start_time") or "").strip() and (s.get("end_time") or "").strip())

            if not rid:
                continue

            if action == "addRow":
                # On create, you MUST send time/day with the room.
                if not has_time:
                    err("ROOM_REQUIRES_TIME", f"{key}: room requires day/start_time/end_time.")
            else:
                # On edit, allow room if payload has times, or existing slot already has times.
                section_id = (payload.get("section_id") or "").strip()
                if not has_time and section_id:
                    existing = await db[COL_SCHEDS].find_one(
                        {"section_id": section_id, "schedule_id": {"$regex": f"^SCH-{re.escape(section_id)}-{idx}$"}},
                        {"_id": 0, "day": 1, "start_time": 1, "end_time": 1}
                    )
                    existing_has_time = bool(existing and (existing.get("day") and existing.get("start_time") and existing.get("end_time")))
                    if not existing_has_time:
                        err("ROOM_REQUIRES_TIME", f"{key}: room requires day/start_time/end_time.")

            # --- Capacity & room_type validation ---
            # Determine effective capacity for the section at this point
            cap_eff = None
            if action == "addRow":
                add_cap = payload.get("enrollment_cap")
                if add_cap in (None, ""):
                    # Use the target course default capacity
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
                if not req_type:
                    err("ROOM_TYPE_REQUIRED", f"{key}: room_type is required when selecting a room.")
                else:
                    rtype = (room.get("room_type") or "").strip()
                    if rtype and req_type.lower() != rtype.lower():
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

    # Duplicate section code — use the *target* course_id (specific if elective)
    if action in {"addRow", "editRow"} and payload.get("section_code"):
        _raw_course = (payload.get("course_id") or payload.get("links", {}).get("course_id") or "").strip()
        _ph = (payload.get("for_placeholder_course_id") or "").strip()
        _spec = (payload.get("specific_course_id") or "").strip()
        target_cid = _spec or _raw_course
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

    # Compute expected prefix for this edit (based on course level + CBL program)
    placeholder_id = (payload.get("for_placeholder_course_id") or "").strip()
    course_id_fallback = (payload.get("course_id") or payload.get("links", {}).get("course_id") or "").strip()
    plan_cid = placeholder_id or course_id_fallback
    plan_lvl = await _course_program_level(plan_cid) if plan_cid else None

    # NEW: if GE/SHS, skip ALL soft checks (no override prompts at all)
    ctype = (await _course_type(plan_cid)) if plan_cid else ""
    if ctype in EDIT_FULL:  # {"GE","SHS"}
        return []

    # resolve program_name from payload/links (for CBL detection)
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

    # Seat-deficit & planned-capacity checks only for non-GE/SHS
    if plan_cid:
        sec_q: Dict[str, Any] = {"term_id": term_id}
        sec_q["$or"] = [{"course_id": plan_cid}, {"fulfilled_placeholder_course_id": plan_cid}]

        # For aggregates, include both XX/XC for Laguna UG
        pref_pat = prefix_pattern_for_level(campus_name, plan_lvl)
        if pref_pat:
            sec_q["section_code"] = {"$regex": f"^{pref_pat}", "$options": "i"}

        planned_cap = 0
        async for s in db[COL_SECTIONS].find(sec_q, {"_id": 0, "enrollment_cap": 1}):
            planned_cap += int(s.get("enrollment_cap") or DEFAULT_CAP)

        cap_delta = 0
        if action == "addRow":
            # capacity contributed by the new section
            add_cap = payload.get("enrollment_cap")
            if add_cap in (None, ""):
                # use the *target* course’s default capacity
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
    block_keys: List[Tuple[str, str, str, int]],  # (batch_id, program_id, label, batch_number)
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

# New: round-robin distribution to support multiple blocks per owner
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
    # count existing sections for this course with the campus-specific prefix
    q: Dict[str, Any] = {"term_id": term_id, "$or": [{"course_id": course_id}, {"fulfilled_placeholder_course_id": course_id}]}
    if campus_prefix:
        q["section_code"] = {"$regex": f"^{campus_prefix}", "$options": "i"}
    existing = await db[COL_SECTIONS].count_documents(q)

    # compute needed by demand
    est = await estimated_demand(term_id, campus_id, course_id)
    total = int(est["plan"] or 0)
    # (call sites should pass capacity=await default_capacity_for_course(course_id))
    needed_by_demand = max(1, ceil((total or 0) / (capacity or DEFAULT_CAP)))
    needed = max(base_per_program, needed_by_demand)

    # create to meet base minimum
    if existing < base_per_program:
        to_make = base_per_program - existing
        for _ in range(to_make):
            code = await next_section_code(campus_prefix, term_id, course_id)
            doc = {
                "section_id": _id("SEC"),
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
            await safe_insert_section(doc)
        existing += to_make

    # create to satisfy demand
    if existing < needed:
        for _ in range(needed - existing):
            code = await next_section_code(campus_prefix, term_id, course_id)
            doc = {
                "section_id": _id("SEC"),
                "section_code": code,
                "course_id": course_id,
                "term_id": term_id,
                "campus_id": campus_id,
                "enrollment_cap": capacity,
                "remarks": "",
                "created_at": now(), "updated_at": now(),
            }
            await safe_insert_section(doc)

async def _create_sections(
    *, term_id: str, campus_id: str, campus_prefix: str, course_id: str, count: int, capacity: int = DEFAULT_CAP
) -> int:
    made = 0
    for _ in range(max(0, int(count))):
        code = await next_section_code(campus_prefix, term_id, course_id)
        doc = {
            "section_id": _id("SEC"),
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
    """
    prefix_map value may be 'S', 'G', 'XX', 'XC', or '(XX|XC)'.
    """
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

    # prefix pattern per course (UG on Laguna => (XX|XC))
    prefix_map: Dict[str, str] = {}
    for cid in view_course_ids:
        lvl = c_map_for_level.get(cid, {}).get("program_level")
        prefix_map[cid] = prefix_pattern_for_level(campus_name, lvl) or ""

    demand_by_course: Dict[str, int] = {}
    for cid in view_course_ids:
        est = await estimated_demand(term_id, campus_id, cid)
        demand_by_course[cid] = est["plan"]
    cap_by_course = await _planned_capacity_by_course_multi(term_id, prefix_map, view_course_ids)

    # base sections per course = at least number of programs that include it
    course_to_programs: Dict[str, set] = {}
    for c in currs:
        pid = c.get("program_id")
        for cid in ensure_list(c.get("course_list")):
            if pid and cid:
                course_to_programs.setdefault(cid, set()).add(pid)
    base_by_course: Dict[str, int] = {cid: max(1, len(ps)) for cid, ps in course_to_programs.items()}

    # Decide by section count (prefix pattern-aware), using per-course default capacity
    for cid in view_course_ids:
        plan = int(demand_by_course.get(cid) or 0)
        existing = await _section_count(term_id, prefix_map.get(cid, ""), cid)
        base = int(base_by_course.get(cid, 1))
        course_cap = await default_capacity_for_course(cid)
        need_demand = max(1, ceil((plan or 0) / (course_cap or DEFAULT_CAP)))
        target = max(base, need_demand)

        if existing < target:
            add_by = target - existing
            changes.append({"type": "sections_increase", "course_id": cid, "by_sections": add_by})
        elif existing > target:
            changes.append({"type": "sections_decrease", "course_id": cid, "by_sections": existing - target})

    return (False, changes, preen_hash, cohort_hash)


async def _planning_flags(term_id: str, campus_id: str, campus_prefix: str):
    """
    Returns (needs_import, approval_required, pending_changes, preen_hash, cohort_hash, plan_state_doc)
    """
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

# ---------- GET ----------
@router.get("/courseofferings")
async def get_course_offerings(
    userId: str = Query(..., min_length=3),
    level: Optional[str] = Query(None),
    department_id: Optional[str] = Query(None),
    batch_id: Optional[str] = Query(None),
    program_id: Optional[str] = Query(None),
    view: Optional[Literal["curriculum", "offerings"]] = Query("offerings"),
):
    # Ensure a current term exists
    t = await current_term() or await _ensure_current_term()
    term_id = (t or {}).get("term_id")
    if not term_id:
        # graceful empty reply
        return {
            "campus": {"campus_id": "", "campus_name": ""},
            "term_id": "", "term_label": "",
            "filters": {"levels": [], "departments": [], "ids": [], "programs": []},
            "rows": [], "course_options_by_group": {}, "room_options": [],
            "planning": {"needs_import": True, "approval_required": False}
        }
    await _sync_section_status_flags(term_id)

    # Resolve campus
    campus_id, _ = await apo_scope(userId)
    if not campus_id:
        raise HTTPException(status_code=400, detail="Unable to resolve APO campus from role_assignments.")
    campus = await campus_meta(campus_id)
    prefix_default = campus_section_prefix(campus.get("campus_name", "")) or ""

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
                    "source": ci.get("source","DB")
                })
            items.append({
                "program_id": pid, "program_code": p.get("program_code",""),
                "department_id": dep_id, "department_name": dep_map.get(dep_id,{}).get("department_name",""),
                "batch_id": bid, "batch_code": _norm_code(b.get("batch_code")),
                "courses": courses,
            })

        # Course picker: only courses from the Program’s department
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
            "term_label": term_label(t),
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

    # Filtered view query (applies UI filters)
    q_view: Dict[str, Any] = {"term_id": term_id, "campus_id": campus_id}
    if batch_id:
        q_view["batch_id"] = batch_id
    if program_id:
        q_view["program_id"] = program_id

    curricula = [x async for x in db[COL_CURRICULUM].find(
        q_view,
        {"_id": 0, "curriculum_id": 1, "program_id": 1, "batch_id": 1, "term_id": 1, "course_list": 1}
    )]

    # ---- Stable Program No. computation: use ALL campus curricula (no filters)
    curricula_all_for_no = [x async for x in db[COL_CURRICULUM].find(
        {"term_id": term_id, "campus_id": campus_id},
        {"_id": 0, "program_id": 1, "batch_id": 1}
    )]

    batch_by_number, batch_by_id = await map_batches()

    # Map programs for both the filtered set (data) and all-for-numbering (labels)
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

    # Build selectable levels using normalized labels
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

    # --- ELECTIVE SUPPORT: build specific-elective pool (type_of_course == 'Elective Course')
    elective_specific_pool: List[Dict[str, Any]] = []
    async for e in db[COL_COURSES].find(
        {"type_of_course": {"$regex": r"^\s*elective\s*course\s*$", "$options": "i"}},
        {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1, "department_id": 1, "program_level": 1}
    ):
        code = _code_str(e.get("course_code"))
        elective_specific_pool.append({
            "course_id": e["course_id"],
            "course_code": code,
            "course_title": e.get("course_title", ""),
            "department_id": e.get("department_id", ""),
            "program_level": e.get("program_level", ""),
        })

    electives_by_dep: Dict[str, List[Dict[str, Any]]] = {}
    for e in elective_specific_pool:
        electives_by_dep.setdefault(e["department_id"], []).append({
            "course_id": e["course_id"],
            "course_code": e["course_code"],
            "course_title": e["course_title"],
        })
    for k in electives_by_dep:
        electives_by_dep[k].sort(key=lambda x: x["course_code"])

    # KEEP this fallback pool too (for departments that have zero 'Elective Course' rows):
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
                dep = cm.get("department_id","")
                opt_item["elective_options"] = electives_by_dep.get(dep) or non_placeholder_by_dep.get(dep, [])

            opts.append(opt_item)

        # de-dup
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

    # For Laguna UG, include BOTH 'XX' and 'XC' in queries
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

    # Map any offered (specific) course_ids not in c_map_all
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

    # ---- Build a STABLE Program No. map from ALL campus curricula ----
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

    # --- Continue with the filtered set for rows
    curricula_sorted = sorted(curricula, key=lambda x: (-_bn(x.get("batch_id")), _pc_view(x.get("program_id"))))

    # Build owner keys per course → then round-robin distribute sections among owners
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
        fa = await db[COL_FAC_ASSIGN].find_one(
            {"term_id": term_id, "section_id": section_id, "is_archived": {"$ne": True}},
            {"_id": 0, "user_id": 1, "faculty_id": 1}
        )
        if not fa:
            return ("UNASSIGNED", None, None)
        uid = (fa.get("user_id") or "").strip() or None
        fid = (fa.get("faculty_id") or "").strip() or None
        if uid:
            u = await db[COL_USERS].find_one(
                {"user_id": uid}, {"_id": 0, "first_name": 1, "last_name": 1, "middle_name": 1}
            )
            name = caps_name(u) if u else f"USER:{uid}"
            return (name, uid, fid)
        if fid:
            fp = await db[COL_FAC_PROFILES].find_one(
                {"faculty_id": fid}, {"_id": 0, "first_name": 1, "last_name": 1, "middle_name": 1, "user_id": 1}
            )
            name = caps_name(fp) if fp else f"FACULTY:{fid}"
            linked_uid = (fp or {}).get("user_id") or None
            return (name, linked_uid, fid)
        return ("UNASSIGNED", None, None)

    async def slot_payload_from_schedules(sid: str):
        scheds = [x async for x in db[COL_SCHEDS].find(
            {"section_id": sid},
            {"_id": 0, "schedule_id": 1, "section_id": 1, "day": 1, "start_time": 1, "end_time": 1, "room_id": 1, "room_type": 1}
        )]
        picked = sorted(
            scheds,
            key=lambda s: (normalize_day(s.get("day")), int(str(s.get("start_time") or "0")))
        )[:2]
        rids = list({sc.get("room_id") for sc in scheds if sc.get("room_id")})
        rmap: Dict[str, Dict[str, Any]] = {}
        if rids:
            async for r in db[COL_ROOMS].find({"room_id": {"$in": rids}}, {"_id": 0, "room_id": 1, "room_number": 1}):
                rmap[r["room_id"]] = r

        def slot_payload(x: Optional[Dict[str, Any]]):
            if not x:
                return None
            rid = (x.get("room_id") or "").strip()
            room_number = (rmap.get(rid) or {}).get("room_number", "")
            if not room_number and rid in {"ONLINE", ""}:
                room_number = "ONLINE" if rid == "ONLINE" else "— TBA —"
            return {
                "schedule_id": x.get("schedule_id", ""),
                "day": normalize_day(x.get("day")),
                "start_time": x.get("start_time", ""),
                "end_time": x.get("end_time", ""),
                "room_id": rid,
                "room_number": room_number,
                "room_type": (x.get("room_type") or ""),
            }

        return (
            slot_payload(picked[0]) if len(picked) >= 1 else None,
            slot_payload(picked[1]) if len(picked) >= 2 else None,
        )

    for cur in curricula_sorted:
        bid = cur.get("batch_id", "")
        pid = cur.get("program_id", "")
        binfo = batch_by_id.get(bid or "", {})
        batch_num = int(binfo.get("batch_number") or 0)
        prog_no_base = prog_no_label_map.get((bid, pid), "PROG-?")  # e.g., "BSCS-1"

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
            course_cap_default = await default_capacity_for_course(course_id)
            suggest_total_sections = ceil((total_intent or 0) / (course_cap_default or DEFAULT_CAP)) or 0
            suggest_additional = max(0, suggest_total_sections - existing_sections)
            deficit = max(0, (total_intent or 0) - planned_cap)

            course_payload = {
                "course_id": course_id,  # NOTE: placeholder (e.g., ITELEC1)
                "course_code": cinfo.get("course_code",""),
                "course_title": cinfo.get("course_title",""),
                "program_level": cinfo.get("program_level",""),
                "program_level_label": cinfo.get("program_level_label",""),
                "department_id": cinfo.get("department_id",""),
                "department_name": dep_name,
                "type_of_course": cinfo.get("type_of_course",""),  # expose to UI
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
                    "links": {"curriculum_id": cur.get("curriculum_id"), "term_id": term_id, "course_id": course_id, "batch_id": binfo.get("batch_id", ""), "program_id": pid},
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

                    rows.append({
                        "program_no": f"{prog_no_base}-{idx}",
                        "block_index": idx,
                        "batch": {"batch_id": binfo.get("batch_id", ""), "batch_code": _norm_code(binfo.get("batch_code")), "batch_number": batch_num or None},
                        "program": {"program_id": pid, "program_code": (prog_map_view.get(pid, {}) or {}).get("program_code", "")},
                        "course": course_payload,
                        "offered_course": offered_payload,
                        "section": {
                            "section_id": sid,
                            "section_code": s.get("section_code", ""),
                            "enrollment_cap": s.get("enrollment_cap"),
                            "remarks": s.get("remarks", "")
                        },
                        "faculty": {"faculty_id": faculty_id_res, "user_id": user_id_res, "faculty_name": faculty_name},
                        "slot1": slot1, "slot2": slot2,
                        "links": {
                            "curriculum_id": cur.get("curriculum_id"),
                            "term_id": term_id,
                            "course_id": course_id,
                            "batch_id": binfo.get("batch_id", ""),
                            "program_id": pid,
                            "section_id": sid
                        },
                        "sizing": sizing_payload(),
                    })

    # ----- deterministic sorting for stable UI
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
        "term_label": term_label(t),
        "filters": {"levels": levels, "departments": dep_opts, "ids": id_opts, "programs": prog_opts},
        "rows": rows,
        "course_options_by_group": options_by_group,
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
        "approvePlan"
    ] = Query(...),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    # Ensure a current term
    t = await current_term() or await _ensure_current_term()
    term_id = (t or {}).get("term_id")
    if not term_id:
        raise HTTPException(status_code=400, detail="No active term.")
    await _sync_section_status_flags(term_id)

    campus_id, _ = await apo_scope(userId)
    if not campus_id:
        raise HTTPException(status_code=400, detail="Unable to resolve APO campus from role_assignments.")
    campus = await campus_meta(campus_id)
    prefix_default = campus_section_prefix(campus.get("campus_name", "")) or ""

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

        # allow custom course creation with units
        if not course_id and payload.get("new_course"):
            nc = payload["new_course"]
            code = _norm_code(nc.get("course_code"))
            title = (nc.get("course_title") or "").strip()
            dep = (nc.get("department_id") or "").strip()
            lvl = level_code(nc.get("program_level"))
            units = nc.get("units")
            if not (code and title and dep and lvl):
                raise HTTPException(status_code=422, detail="new_course requires course_code, course_title, department_id, program_level.")
            cid = _id("CRS")
            doc = {
                "course_id": cid, "course_code": code, "course_title": title,
                "department_id": dep, "program_level": lvl, "source": "custom",
                "created_at": now(), "updated_at": now()
            }
            if units is not None:
                try:
                    doc["units"] = float(units)
                except Exception:
                    pass
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
        old_cid = (payload.get("old_course_id") or "").strip()
        new_cid = (payload.get("new_course_id") or "").strip()
        upd = payload.get("update_course")
        if not (pid and bid and old_cid):
            raise HTTPException(status_code=422, detail="program_id, batch_id, old_course_id are required.")

        cur_doc = await db[COL_CURRICULUM].find_one(
            {"term_id": term_id, "campus_id": campus_id, "program_id": pid, "batch_id": bid}
        )
        if not cur_doc:
            raise HTTPException(status_code=404, detail="Curriculum not found.")

        # inline edit of course fields (title/level/units)
        if upd:
            f: Dict[str, Any] = {}
            if "course_title" in upd:
                f["course_title"] = (upd.get("course_title") or "").strip()
            if "program_level" in upd and upd.get("program_level"):
                f["program_level"] = level_code(upd.get("program_level"))
            if "units" in upd:
                units_val = upd.get("units")
                if units_val in (None, ""):
                    f["units"] = None
                else:
                    try:
                        f["units"] = float(units_val)
                    except Exception:
                        pass
            if f:
                await db[COL_COURSES].update_one({"course_id": old_cid}, {"$set": {**f, "updated_at": now()}})
            return {"ok": True, "course_id": old_cid}

        # replace course id in curriculum list
        if not new_cid:
            raise HTTPException(status_code=422, detail="new_course_id or update_course must be provided.")
        clist = [c for c in ensure_list(cur_doc.get("course_list")) if c != old_cid]
        clist.append(new_cid)
        await db[COL_CURRICULUM].update_one({"_id": cur_doc["_id"]}, {"$set": {"course_list": clist, "updated_at": now()}})
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

        # base sections per course = at least number of programs that include it
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

        # helper to choose prefix for creation (Laguna UG → XC if any owner is CBL, else XX)
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
                    return "XX"  # GS default if ever needed on Laguna
                return "XC" if any_cbl else "XX"
            # Manila
            return "G" if level_code(lvl) == "GSM" else "S"

        # 1) add courses to curriculum where pending recommends it
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

        # 2) adjust sections to match capacity intent
        for ch in pending:
            if ch.get("type") not in {"sections_increase", "sections_decrease"}:
                continue

            cid = (ch.get("course_id") or "").strip()
            if not cid:
                continue

            # Use pattern for queries, but a concrete prefix when creating new
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
                    course_cap = await default_capacity_for_course(cid)
                    by_sections = ceil(by_cap / (course_cap or DEFAULT_CAP)) if by_cap > 0 else 0

                need_base = max(0, base - existing)
                if need_base:
                    creation_prefix = await _choose_creation_prefix(cid)
                    await _create_sections(
                        term_id=term_id,
                        campus_id=campus_id,
                        campus_prefix=creation_prefix,
                        course_id=cid,
                        count=need_base,
                        capacity=await default_capacity_for_course(cid)
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
                        capacity=await default_capacity_for_course(cid)
                    )

            else:  # sections_decrease
                by_sections = int(ch.get("by_sections") or 0)
                if by_sections > 0:
                    target = max(base, existing - by_sections)
                else:
                    est = await estimated_demand(term_id, campus_id, cid)
                    course_cap = await default_capacity_for_course(cid)
                    target = max(base, ceil((est["plan"] or 0) / (course_cap or DEFAULT_CAP)) or 1)

                # Prefer reduction across both XX and XC (pattern works)
                await reduce_sections_if_excess(
                    term_id=term_id, campus_prefix=pref_pat,
                    course_id=cid, target_count=target
                )

        # mark approved with the exact hashes we just applied
        await db[COL_PLANSTATE].update_one(
            {"term_id": term_id, "campus_id": campus_id},
            {"$set": {"last_preen_hash": preen_hash, "last_cohort_hash": cohort_hash, "approved": True, "updated_at": now()}},
            upsert=True
        )
        return {"ok": True, "applied": len(pending)}

    # ----- GE/SHS EXEMPTION: planning gate is skipped for GE/SHS -----
    plan_warning = False
    if action in {"addRow", "editRow", "deleteRow"}:
        # Determine target course to decide if we should exempt from planning gate
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
            ge_shs_exempt = (ctype in EDIT_FULL)  # {"GE","SHS"}

        # Only non-GE/SHS are blocked by planning gate
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

    if plan_warning:
        soft.append({
            "code": "PLAN_NOT_APPROVED",
            "level": "warning",
            "message": "Planning updates for this term are pending approval. Proceeding will be recorded as an override.",
        })

    auto_override = bool((payload or {}).get("auto_override"))
    if soft and auto_override:
        reason = (payload.get("override_reason") or "Auto-override from UI").strip() or "Auto-override from UI"
        await audit_override(
            user_id=userId,
            action=action,
            reason=reason,
            violations=soft,
            payload=payload,
        )
        soft = []

    if soft and not payload.get("override"):
        _raw_course = (payload.get("course_id") or payload.get("links", {}).get("course_id") or "").strip()
        _spec = (payload.get("specific_course_id") or "").strip()
        preview_cid = _spec or _raw_course

        pv_lvl = await _course_program_level(preview_cid) if preview_cid else None
        # For preview, we don't know program_name; use broad pattern for Laguna UG so user sees XX/XC expectation
        pv_pat = prefix_pattern_for_level(campus.get("campus_name",""), pv_lvl) or prefix_default
        # choose a concrete preview code using first option in pattern
        pv_prefix = "XX" if pv_pat == "(XX|XC)" else pv_pat

        tok = await issue_override_token(user_id=userId, payload=payload, violations=soft, ttl_sec=300)
        preview = {}
        if action == "addRow":
            # preview capacity: use per-course default if not provided
            add_cap = payload.get("enrollment_cap")
            if add_cap in (None, ""):
                add_cap = await default_capacity_for_course(preview_cid) if preview_cid else DEFAULT_CAP
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
            detail={"ok": False, "conflict": True, "override_token": tok, "violations": soft, "preview_changes": preview}
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

        # ELECTIVE target course resolution
        placeholder_id = (payload.get("for_placeholder_course_id") or "").strip()
        specific_id = (payload.get("specific_course_id") or "").strip()
        raw_course_id = (payload.get("course_id") or "").strip()
        if placeholder_id and specific_id:
            target_course_id = specific_id
        else:
            target_course_id = raw_course_id

        ctype_target = await _course_type(target_course_id)
        is_full = ctype_target in EDIT_FULL  # GE/SHS free edits

        b = await db[COL_BATCHES].find_one({"batch_id": batch_id}, {"_id": 0, "batch_number": 1, "batch_code": 1})
        batch_number = _extract_batch_number(b or {})

        # choose prefix per course level + CBL (program_name)
        lvl = await _course_program_level(target_course_id)
        prog_id = (payload.get("program_id") or "").strip()
        prog_name = await _program_name(prog_id) if prog_id else None
        chosen_prefix = campus_section_prefix_for_course(campus.get("campus_name",""), lvl, prog_name) or prefix_default

        # NOTE: GE can supply ANY section_code; we don't enforce pattern (soft checks already skipped)
        section_code = (payload.get("section_code") or "").strip() or await next_section_code(chosen_prefix, term_id, target_course_id)

        sid = _id("SEC")
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
        if placeholder_id:
            doc["fulfilled_placeholder_course_id"] = placeholder_id
        inserted = await safe_insert_section(doc)
        if not inserted:
            raise HTTPException(status_code=409, detail="Could not allocate a unique section code. Try again.")

        # ---- Schedules
        for idx, key in enumerate(["slot1", "slot2"], start=1):
            s = (payload.get(key) or {})
            day = normalize_day(s.get("day"))
            beg = (s.get("start_time") or "").strip()
            end = (s.get("end_time") or "").strip()
            rid = (s.get("room_id") or "").strip()
            rtype = (s.get("room_type") or "").strip()

            has_time = bool(day and beg and end)

            if is_full:
                if rid and not has_time:
                    raise HTTPException(status_code=422, detail={"ok": False, "errors": [
                        {"code": "ROOM_REQUIRES_TIME", "message": f"{key}: room requires day/start_time/end_time."}
                    ]})
                if has_time or rid:
                    await db[COL_SCHEDS].insert_one({
                        "schedule_id": f"SCH-{sid}-{idx}",
                        "section_id": sid,
                        "day": day if has_time else "",
                        "start_time": beg if has_time else "",
                        "end_time": end if has_time else "",
                        "room_id": rid if rid else "",
                        "room_type": rtype,
                        "created_at": now(), "updated_at": now(),
                    })
            else:
                if rid:
                    if not has_time:
                        raise HTTPException(status_code=422, detail={"ok": False, "errors": [
                            {"code": "ROOM_REQUIRES_TIME", "message": f"{key}: room requires day/start_time/end_time."}
                        ]})
                    await db[COL_SCHEDS].insert_one({
                        "schedule_id": f"SCH-{sid}-{idx}",
                        "section_id": sid, "day": day, "start_time": beg, "end_time": end,
                        "room_id": rid, "room_type": rtype,
                        "created_at": now(), "updated_at": now(),
                    })

        # ---- Faculty on CREATE for GE/SHS (optional)
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
                    await db[COL_FAC_ASSIGN].update_one(
                        {"term_id": term_id, "section_id": sid},
                        {"$set": {
                            "user_id": uid or None,
                            "faculty_id": fid or None,
                            "is_archived": False,
                            "updated_at": now()
                        },
                         "$setOnInsert": {"faculty_assignment_id": _id("FAS"), "created_at": now()}},
                        upsert=True
                    )

        return {"ok": True, "section_id": sid}

    # ---------- EDIT ROW ----------
    if action == "editRow":
        section_id = (payload.get("section_id") or "").strip()

        # Resolve course type for rule gating
        cid_for_edit = (payload.get("course_id") or "").strip()
        if not cid_for_edit:
            sec_doc = await db[COL_SECTIONS].find_one({"section_id": section_id}, {"_id": 0, "course_id": 1})
            cid_for_edit = (sec_doc or {}).get("course_id", "")
        ctype = (await _course_type(cid_for_edit))
        is_full = ctype in EDIT_FULL  # GE/SHS free edits

        # Optional: change course code/title from offerings
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

        # Section basics
        sec_updates: Dict[str, Any] = {}
        if "section_code" in payload:
            sec_updates["section_code"] = (payload.get("section_code") or "").strip()
        if "enrollment_cap" in payload:
            cap = payload.get("enrollment_cap")
            sec_updates["enrollment_cap"] = int(cap) if cap not in (None, "") else None
        if "remarks" in payload:
            sec_updates["remarks"] = (payload.get("remarks") or "").strip()

        # ELECTIVE: switch specific elective and/or set placeholder link
        _new_specific    = (payload.get("specific_course_id") or "").strip()
        _new_placeholder = (payload.get("for_placeholder_course_id") or "").strip()
        if _new_specific:
            sec_updates["course_id"] = _new_specific
        if _new_placeholder:
            sec_updates["fulfilled_placeholder_course_id"] = _new_placeholder
        if sec_updates:
            sec_updates["updated_at"] = now()
            await db[COL_SECTIONS].update_one({"section_id": section_id}, {"$set": sec_updates})

        # Schedules
        for idx, key in enumerate(["slot1", "slot2"], start=1):
            s = payload.get(key)
            if s is None:
                continue

            rid = (s.get("room_id") or "").strip()
            rtype = (s.get("room_type") or "").strip()
            day = (s.get("day") or "").strip() if is_full else ""
            beg = (s.get("start_time") or "").strip() if is_full else ""
            end = (s.get("end_time") or "").strip() if is_full else ""

            existing = await db[COL_SCHEDS].find_one(
                {"section_id": section_id, "schedule_id": {"$regex": f"^SCH-{re.escape(section_id)}-{idx}$"}}
            )

            has_time_now = bool(day and beg and end)
            existing_has_time = bool(existing and existing.get("day") and existing.get("start_time") and existing.get("end_time"))
            payload_has_any_time_key = is_full and any(k in s for k in ("day", "start_time", "end_time"))

            if rid:
                if not (has_time_now or existing_has_time):
                    raise HTTPException(status_code=422, detail={"ok": False, "errors": [
                        {"code": "ROOM_REQUIRES_TIME", "message": f"{key}: room requires day/start_time/end_time."}
                    ]})

            if existing:
                if is_full and payload_has_any_time_key and (not has_time_now) and (rid == ""):
                    await db[COL_SCHEDS].delete_one({"_id": existing["_id"]})
                    continue

                upd = {"updated_at": now()}
                if rid != "":
                    upd["room_id"] = rid
                if "room_type" in s:
                    upd["room_type"] = rtype
                if is_full and ("room_id" in s) and rid == "":
                    upd["room_id"] = ""

                if is_full and payload_has_any_time_key:
                    upd.update({"day": day, "start_time": beg, "end_time": end})

                await db[COL_SCHEDS].update_one({"_id": existing["_id"]}, {"$set": upd})

            else:
                if rid:
                    doc = {
                        "schedule_id": f"SCH-{section_id}-{idx}",
                        "section_id": section_id,
                        "room_id": rid,
                        "room_type": rtype,
                        "created_at": now(), "updated_at": now(),
                    }
                    if is_full:
                        doc.update({"day": day, "start_time": beg, "end_time": end})
                    if not is_full and not existing_has_time:
                        raise HTTPException(status_code=422, detail={"ok": False, "errors": [
                            {"code": "ROOM_REQUIRES_TIME", "message": f"{key}: room requires day/start_time/end_time."}
                        ]})
                    await db[COL_SCHEDS].insert_one(doc)

                elif is_full and has_time_now:
                    await db[COL_SCHEDS].insert_one({
                        "schedule_id": f"SCH-{section_id}-{idx}",
                        "section_id": section_id,
                        "day": day, "start_time": beg, "end_time": end,
                        "room_id": "", "room_type": rtype,
                        "created_at": now(), "updated_at": now(),
                    })

        # Faculty updates for GE/SHS
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
                    {"term_id": term_id, "section_id": section_id, "is_archived": {"$ne": True}},
                    {"$set": {"is_archived": True, "updated_at": now()}}
                )
                await db[COL_FAC_ASSIGN].update_one(
                    {"term_id": term_id, "section_id": section_id},
                    {"$set": {
                        "user_id": uid or None,
                        "faculty_id": fid or None,
                        "is_archived": False,
                        "updated_at": now()
                    },
                     "$setOnInsert": {"faculty_assignment_id": _id("FAS"), "created_at": now()}},
                    upsert=True
                )

        return {"ok": True, "section_id": section_id}

    # ---------- DELETE ROW ----------
    if action == "deleteRow":
        section_id = (payload.get("section_id") or "").strip()
        await db[COL_SCHEDS].delete_many({"section_id": section_id})
        await db[COL_FAC_ASSIGN].update_many({"section_id": section_id}, {"$set": {"is_archived": True, "updated_at": now()}})
        await db[COL_SECTIONS].delete_one({"section_id": section_id})
        return {"ok": True, "deleted": 1}

    raise HTTPException(status_code=400, detail="Invalid action.")
