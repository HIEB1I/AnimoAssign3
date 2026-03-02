# backend/app/OM/facultymanagement.py
from typing import Any, Dict, List, Optional
import re
from datetime import datetime, timezone, date
from fastapi import APIRouter, HTTPException, Query, Body
from ..main import db

router = APIRouter(prefix="/om", tags=["om"])

# ---------- Collections ----------
COL_USERS = "users"
COL_FACULTY = "faculty_profiles"
COL_DEPARTMENTS = "departments"
COL_TERMS = "terms"
COL_PREEN_COUNT = "preenlistment_count"   # NEW: for working/ planning term
COL_SECTIONS = "sections"                 # adjust if your collection name differs
COL_ASSIGNMENTS = "faculty_assignments" 
COL_PREFS = "faculty_preferences"
COL_ROLE_ASSIGN = "role_assignments"
COL_USER_ROLES = "user_roles"             # uses { role_id, role_type, ... }
COL_COURSES = "courses"                   # NEW: to fetch course_title/units for schedule
COL_DELOADINGS = "deloadings"             # NEW: faculty deloading records
COL_DELOADING_TYPES = "deloading_types"     # NEW: deloading type lookup

WEEKDAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

# ---------- Day / time helpers ----------
_DAY_MAP = {
    "M": "Monday", "MON": "Monday",
    "T": "Tuesday", "TU": "Tuesday", "TUE": "Tuesday",
    "W": "Wednesday", "WED": "Wednesday",
    "TH": "Thursday", "THU": "Thursday", "R": "Thursday",
    "F": "Friday", "FRI": "Friday",
    "S": "Saturday", "SAT": "Saturday",
}
def _to_full_day(day_val: str) -> str:
    s = (day_val or "").strip().upper()
    return _DAY_MAP.get(s, (day_val or "").strip() or "")

# Day initials expected by OM tables (M/T/W/H/F/S)
_DAY_INITIAL_MAP = {
    "M": "M", "MON": "M", "MONDAY": "M",
    "T": "T", "TU": "T", "TUE": "T", "TUESDAY": "T",
    "W": "W", "WED": "W", "WEDNESDAY": "W",
    "H": "H", "TH": "H", "THU": "H", "THUR": "H", "THURS": "H", "THURSDAY": "H", "R": "H",
    "F": "F", "FRI": "F", "FRIDAY": "F",
    "S": "S", "SAT": "S", "SATURDAY": "S",
    "U": "U", "SUN": "U", "SUNDAY": "U",
}

_DAY_INITIAL_ORDER = {"M": 1, "T": 2, "W": 3, "H": 4, "F": 5, "S": 6, "U": 7}

def _to_day_initial(day_val: Any) -> str:
    s = (str(day_val) if day_val is not None else "").strip()
    if not s:
        return ""
    up = s.strip().upper()

    # Exact known tokens
    if up in _DAY_INITIAL_MAP:
        return _DAY_INITIAL_MAP[up]

    # Full day names / prefixes
    if up.startswith("MON"):
        return "M"
    if up.startswith("TUE"):
        return "T"
    if up.startswith("WED"):
        return "W"
    if up.startswith("THU") or up.startswith("THR") or up.startswith("TH"):
        return "H"
    if up.startswith("FRI"):
        return "F"
    if up.startswith("SAT"):
        return "S"
    if up.startswith("SUN"):
        return "U"

    # Fall back as-is (better than losing information)
    return s

def _extract_mode_from_remarks(remarks: Any) -> str:
    """Mode is stored on sections.remarks (e.g., Hybrid, FOL, F2F/FTF, Online)."""
    if remarks is None:
        return "Online"
    if isinstance(remarks, dict):
        for k in ("mode", "delivery_mode", "class_mode", "section_mode"):
            v = remarks.get(k)
            if v:
                return str(v).strip()
        # fall back to a stringy representation
        remarks = " ".join(str(v) for v in remarks.values() if v)

    if isinstance(remarks, list):
        remarks = " ".join(str(x) for x in remarks if x)

    s = str(remarks).strip()
    if not s:
        return "Online"

    up = s.upper()
    if "HYBRID" in up:
        return "Hybrid"
    if "FOL" in up:
        return "FOL"
    if "F2F" in up:
        return "F2F"
    if "FTF" in up or "FACE" in up:
        return "FTF"
    if "ONLINE" in up:
        return "Online"
    if "BLENDED" in up:
        return "Blended"

    # Last-resort: keep whatever is in remarks (trimmed)
    return s
def _fmt_hhmm(raw: Any) -> str:
    """
    Input like "730" or 730 -> "07:30"
    Also passes through "07:30" unchanged.
    """
    if raw is None:
        return ""
    s = str(raw).strip()
    if ":" in s:
        return s  # already hh:mm
    if not s.isdigit():
        return s
    if len(s) == 3:
        h, m = int(s[0]), int(s[1:])
    elif len(s) == 4:
        h, m = int(s[:2]), int(s[2:])
    else:
        return s
    return f"{h:02d}:{m:02d}"

def _fmt_time_band(start_raw: Any, end_raw: Any) -> str:
    st = _fmt_hhmm(start_raw)
    en = _fmt_hhmm(end_raw)
    return f"{st} – {en}".strip(" –")

# ---------- Faculty details helpers ----------

def _normalize_certifications(raw: Any) -> List[str]:
    """Normalize certifications into a list of strings.

    Accepts list[str], comma-separated string, or None.
    """
    if raw is None:
        return []
    parts: List[str] = []
    if isinstance(raw, list):
        for item in raw:
            for piece in str(item or '').split(','):
                parts.append(piece)
    else:
        for piece in str(raw or '').split(','):
            parts.append(piece)
    return [p.strip() for p in parts if p and p.strip()]


def _normalize_hire_date(hire_date_raw: Any) -> Optional[str]:
    """Normalize hire/start date into YYYY-MM-DD string (or None).

    Accepts:
      - datetime / date objects
      - Mongo-style dicts like {"$date": "..."} or {"$date": 1710000000000}
      - ISO strings like "2022-05-05T00:00:00+08:00" or "2022-05-05T00:00:00Z"
      - Plain "YYYY-MM-DD" strings
    """
    if hire_date_raw is None:
        return None

    # Mongo export patterns
    if isinstance(hire_date_raw, dict) and "$date" in hire_date_raw:
        hire_date_raw = hire_date_raw.get("$date")

    # already a datetime/date
    if isinstance(hire_date_raw, datetime):
        return hire_date_raw.date().isoformat()
    if isinstance(hire_date_raw, date):
        return hire_date_raw.isoformat()

    s = str(hire_date_raw).strip()
    if not s:
        return None

    # Fast path: take the date portion of ISO-like strings
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", s)
    if m:
        try:
            return datetime.strptime(m.group(1), "%Y-%m-%d").date().isoformat()
        except Exception:
            pass

    # Try to parse as ISO8601 datetime
    try:
        iso = s.replace("Z", "+00:00")  # Python fromisoformat doesn't accept 'Z'
        dt = datetime.fromisoformat(iso)
        return dt.date().isoformat()
    except Exception:
        return None
def _teaching_years_from_hire_date(hire_date_str: Optional[str]) -> Optional[int]:
    """Compute whole-year teaching years from a YYYY-MM-DD hire date string."""
    if not hire_date_str:
        return None
    try:
        hire_dt = datetime.strptime(hire_date_str, '%Y-%m-%d').date()
    except Exception:
        return None

    today = datetime.now(timezone.utc).date()
    years = today.year - hire_dt.year
    if (today.month, today.day) < (hire_dt.month, hire_dt.day):
        years -= 1
    return max(0, years)


def _coerce_int(val: Any) -> Optional[int]:
    if val is None or val == '':
        return None
    try:
        return int(val)
    except Exception:
        return None


# ---------- Expression helpers ----------
def _dept_name_expr():
    return {"$ifNull": ["$dept.department_name", "$dept.dept_name"]}

def _full_name_expr():
    return {
        "$trim": {
            "input": {"$concat": [
                {"$ifNull": ["$u.first_name", ""]}, " ",
                {"$ifNull": ["$u.last_name",  ""]}
            ]}
        }
    }

def _role_display_expr():
    return {"$ifNull": ["$role.role_type", ""]}

async def _active_term() -> Dict[str, Any]:
    """
    Return the WORKING / PLANNING term for OM Faculty Management.

    Priority:
    1) If there is an active (non-archived) pre-enlistment batch in
       preenlistment_count, use that term_id.
    2) Otherwise, use the *next* term after the current term
       (where is_current/status flags it as current/active).
    3) If there is no "next" term configured, fall back to the current/latest term.
    """

    # 1) Try to derive from an active pre-enlistment batch
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

    # 2) Fallback: "current" term (any of the usual flags)
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

    if not current:
        # If nothing is flagged, use the latest by AY + term_number
        last = await db[COL_TERMS].find(
            {}, {"_id": 0, "term_id": 1, "term_number": 1, "acad_year_start": 1},
        ).sort([("acad_year_start", -1), ("term_number", -1)]).limit(1).to_list(1)
        current = last[0] if last else None

    if not current:
        # No terms at all
        return {}

    # 3) Compute the "next" term after the current term
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
        {"_id": 0, "term_id": 1, "term_number": 1, "acad_year_start": 1},
    ).sort([("acad_year_start", 1), ("term_number", 1)]).limit(1).to_list(1)

    if next_terms:
        # Use the next term as the working/planning term
        return next_terms[0]

    # If no next term, stick with current (still better than nothing)
    return current


async def _current_term() -> Dict[str, Any]:
    """Return the CURRENT/ACTIVE term (not the planning/next term)."""
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
    if not current:
        last = await db[COL_TERMS].find(
            {}, {"_id": 0, "term_id": 1, "term_number": 1, "acad_year_start": 1}
        ).sort([("acad_year_start", -1), ("term_number", -1)]).limit(1).to_list(1)
        current = last[0] if last else None
    return current or {}


async def _resolve_faculty_match_ids(faculty_id_or_user_id: str) -> List[str]:
    """Return identifiers that may appear in faculty_assignments.faculty_id.

    In seeded/legacy data, faculty_assignments.faculty_id can be either the
    faculty profile id (faculty_profiles.faculty_id) OR the user id (users.user_id).
    We resolve both (and a best-effort user_id via email) so history/schedule
    works consistently across datasets.
    """
    base = (str(faculty_id_or_user_id) if faculty_id_or_user_id is not None else "").strip()
    if not base:
        return []

    ids: List[str] = [base]

    fac = await db[COL_FACULTY].find_one(
        {"$or": [{"faculty_id": base}, {"user_id": base}, {"email": base}]},
        {"_id": 0, "faculty_id": 1, "user_id": 1, "email": 1},
    )

    if fac:
        if fac.get("faculty_id"):
            ids.append(str(fac.get("faculty_id")))
        if fac.get("user_id"):
            ids.append(str(fac.get("user_id")))
        if fac.get("email"):
            ids.append(str(fac.get("email") or "").strip().lower())

    # Resolve user_id by email (common when faculty_profiles.user_id is missing)
    email = None
    if fac and fac.get("email"):
        email = str(fac.get("email") or "").strip().lower()
    elif "@" in base:
        email = base.strip().lower()

    if email:
        user = await db[COL_USERS].find_one({"email": email}, {"_id": 0, "user_id": 1})
        if user and user.get("user_id"):
            ids.append(str(user.get("user_id")))

    # De-dupe, drop empties
    out: List[str] = []
    seen = set()
    for x in ids:
        s = (str(x) if x is not None else "").strip()
        if not s:
            continue
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


async def _faculty_academic_years(fid_str: str) -> List[int]:
    """Return academic years where the faculty has teaching assignments.

    IMPORTANT:
    Teaching *history* must include archived assignment rows (many past terms are
    stored with `is_archived=True`). Filtering archived rows here causes the UI
    to show "No teaching history found" even when data exists (e.g. Reports &
    Analytics Teaching History still shows rows because it does not filter).
    """
    if not fid_str:
        return []

    match_ids = await _resolve_faculty_match_ids(fid_str)
    if not match_ids:
        match_ids = [fid_str]

    # NOTE: DO NOT filter out archived rows for history discovery.
    pipeline: List[Dict[str, Any]] = [
        {"$match": {"$expr": {"$and": [
            {"$in": [{"$toString": "$faculty_id"}, match_ids]},
        ]}}},
        {"$lookup": {"from": COL_SECTIONS, "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
        {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": False}},
        {"$lookup": {
            "from": COL_TERMS,
            "let": {"tid": "$sec.term_id"},
            "pipeline": [
                {"$match": {"$expr": {"$eq": [
                    {"$toString": "$term_id"},
                    {"$toString": "$$tid"},
                ]}}},
                {"$project": {"_id": 0, "acad_year_start": 1}},
            ],
            "as": "t"
        }},
        {"$unwind": {"path": "$t", "preserveNullAndEmptyArrays": False}},
        {"$match": {"t.acad_year_start": {"$ne": None}}},
        {"$group": {"_id": "$t.acad_year_start"}},
        {"$project": {"_id": 0, "acad_year_start": "$_id"}},
        {"$sort": {"acad_year_start": -1}},
    ]

    years: List[int] = []
    async for r in db[COL_ASSIGNMENTS].aggregate(pipeline, allowDiskUse=True):
        y = r.get("acad_year_start")
        try:
            years.append(int(y))
        except Exception:
            continue

    return sorted(set(years), reverse=True)



async def _faculty_terms(fid_str: str) -> List[Dict[str, Any]]:
    """Return distinct term docs where the faculty has assignments.

    NOTE: Past teaching loads are commonly stored under `is_archived=True`, so we
    must include archived rows for navigation (Prev/Next Term) to work.
    """
    if not fid_str:
        return []

    match_ids = await _resolve_faculty_match_ids(fid_str)
    if not match_ids:
        match_ids = [fid_str]

    # NOTE: DO NOT filter out archived rows for term discovery.
    pipeline: List[Dict[str, Any]] = [
        {"$match": {"$expr": {"$and": [
            {"$in": [{"$toString": "$faculty_id"}, match_ids]},
        ]}}},
        {"$lookup": {"from": COL_SECTIONS, "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
        {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": False}},
        {"$group": {"_id": {"$toString": "$sec.term_id"}}},
        {"$project": {"_id": 0, "term_id": "$_id"}},
        {"$lookup": {
            "from": COL_TERMS,
            "let": {"tid": "$term_id"},
            "pipeline": [
                {"$match": {"$expr": {"$eq": [
                    {"$toString": "$term_id"},
                    {"$toString": "$$tid"},
                ]}}},
                {"$project": {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1}},
            ],
            "as": "t"
        }},
        {"$unwind": {"path": "$t", "preserveNullAndEmptyArrays": True}},
        {"$project": {
            "_id": 0,
            "term_id": {"$ifNull": ["$t.term_id", "$term_id"]},
            "acad_year_start": "$t.acad_year_start",
            "term_number": "$t.term_number",
        }},
    ]

    raw = [r async for r in db[COL_ASSIGNMENTS].aggregate(pipeline, allowDiskUse=True)]
    out: List[Dict[str, Any]] = []
    seen = set()
    for r in raw:
        tid = r.get("term_id")
        tid_str = str(tid) if tid is not None else ""
        if not tid_str or tid_str in seen:
            continue
        seen.add(tid_str)
        out.append({
            "term_id": tid,
            "acad_year_start": r.get("acad_year_start"),
            "term_number": r.get("term_number"),
        })

    def _k(t: Dict[str, Any]):
        ay = t.get("acad_year_start")
        try:
            ay = int(ay)
        except Exception:
            ay = 9999
        tn = t.get("term_number")
        try:
            tn = int(tn)
        except Exception:
            tn = 99
        return (ay, tn, str(t.get("term_id") or ""))

    out.sort(key=_k)
    return out

# ---------- Route ----------
@router.post("/facultymanagement")
async def facultymanagement_handler(
    action: str = Query("list", description="header | options | list | details | schedule | history"),

    # header (who’s logged in)
    userEmail: Optional[str] = Query(None),
    userId: Optional[str] = Query(None),

    # list filters
    department: Optional[str] = Query(None),
    facultyType: Optional[str] = Query(None, description="Full-Time | Part-Time | All Type"),
    search: Optional[str] = Query(None),

    # details
    facultyId: Optional[str] = Query(None),
    termId: Optional[str] = Query(None),
    acadYearStart: Optional[int] = Query(None),

    payload: Optional[Dict[str, Any]] = Body(None),
):
    # ----- HEADER -----
    if action == "header":
        if not userEmail and not userId:
            raise HTTPException(status_code=400, detail="userEmail or userId is required.")

        user_match: Dict[str, Any] = {"user_id": userId} if userId else {"email": userEmail}

        pipeline: List[Dict[str, Any]] = [
            {"$match": user_match},
            {"$project": {"_id": 0, "user_id": 1, "email": 1, "first_name": 1, "last_name": 1}},
            {"$lookup": {
                "from": COL_ROLE_ASSIGN,
                "localField": "user_id",
                "foreignField": "user_id",
                "as": "ra_list"
            }},
            {"$unwind": {"path": "$ra_list", "preserveNullAndEmptyArrays": True}},
            {"$addFields": {
                "deptScope": {
                    "$first": {
                        "$filter": {
                            "input": {"$ifNull": ["$ra_list.scope", []]},
                            "as": "s",
                            "cond": {"$eq": ["$$s.type", "department"]}
                        }
                    }
                },
                "role_id_from_ra": "$ra_list.role_id",
            }},
            {"$lookup": {
                "from": COL_DEPARTMENTS,
                "localField": "deptScope.id",
                "foreignField": "department_id",
                "as": "dept"
            }},
            {"$unwind": {"path": "$dept", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {
                "from": COL_USER_ROLES,
                "localField": "role_id_from_ra",
                "foreignField": "role_id",
                "as": "role"
            }},
            {"$unwind": {"path": "$role", "preserveNullAndEmptyArrays": True}},
            {"$addFields": {
                "full_name": {
                    "$trim": {"input": {"$concat": [
                        {"$ifNull": ["$first_name", ""]}, " ",
                        {"$ifNull": ["$last_name",  ""]}
                    ]}}
                },
                "dept_name": {"$ifNull": ["$dept.department_name", "$dept.dept_name"]},
                "role_display": _role_display_expr(),
            }},
            {"$project": {
                "_id": 0,
                "email": 1,
                "role_type": "$role.role_type",
                "department_id": "$deptScope.id",
                "profileName": "$full_name",
                "profileSubtitle": {
                    "$trim": {
                        "input": {
                            "$concat": [
                                {"$ifNull": ["$role_display", ""]},
                                {"$cond": [{"$ifNull": ["$dept_name", False]}, " | ", ""]},
                                {"$ifNull": ["$dept_name", ""]},
                            ]
                        }
                    }
                }
            }},
            {"$limit": 1}
        ]

        docs = [d async for d in db[COL_USERS].aggregate(pipeline)]
        if not docs:
            return {"ok": False, "message": "User not found."}
        return {"ok": True, **docs[0]}

    # ----- OPTIONS -----
    if action == "options":
        depts = [d async for d in db[COL_DEPARTMENTS]
                 .find({}, {"_id": 0, "department_name": 1, "dept_name": 1})]
        department_options = sorted({
            (d.get("department_name") or d.get("dept_name") or "").strip()
            for d in depts if (d.get("department_name") or d.get("dept_name"))
        })

        codes = await db[COL_FACULTY].distinct("employment_type")  # FT / PT
        type_map = {"FT": "Full-Time", "PT": "Part-Time"}
        faculty_types = sorted({type_map.get(c, c) for c in codes if c})

        terms = [t async for t in db[COL_TERMS]
                 .find({}, {"_id": 0, "acad_year_start": 1})
                 .sort([("acad_year_start", -1)])]
        ay_list = sorted({t.get("acad_year_start") for t in terms if t.get("acad_year_start")},
                         reverse=True)

        active = await _active_term()

        return {
            "ok": True,
            "departments": department_options,
            "facultyTypes": faculty_types,
            "academicYears": ay_list,
            "activeTerm": active,   # NEW: working / planning term for subtitle
        }

    # ----- LIST -----
    if action == "list":

        # Determine active term to prioritize its preferences
        active = await _active_term()
        active_term_id = active.get("term_id")

        active_term_id_str = str(active_term_id) if active_term_id is not None else None
        early_match: Dict[str, Any] = {}
        if facultyType and facultyType.strip().lower() != "all type":
            code = {"Full-Time": "FT", "Part-Time": "PT"}.get(facultyType.strip())
            if code:
                early_match["employment_type"] = code

        dept_filter = (department or "").strip()
        if dept_filter.lower() == "all departments":
            dept_filter = ""

        pipeline: List[Dict[str, Any]] = [
            {"$match": early_match},
            {"$lookup": {
                "from": COL_DEPARTMENTS,
                "localField": "department_id",
                "foreignField": "department_id",
                "as": "dept",
            }},
            {"$unwind": {"path": "$dept", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {
                "from": COL_USERS,
                "let": {"uid": "$user_id", "femail": "$email"},
                "pipeline": [
                    {"$match": {"$expr": {"$or": [
                        {"$and": [{"$ne": ["$$uid", None]}, {"$eq": [{"$toString": "$user_id"}, {"$toString": "$$uid"}]}]},
                        {"$and": [{"$ne": ["$$femail", None]}, {"$eq": ["$email", "$$femail"]}]},
                    ]}}},  # noqa: E231
                    {"$project": {"_id": 0, "user_id": 1, "first_name": 1, "last_name": 1, "status": 1, "email": 1}}
                ],
                "as": "u"
            }},
            {"$unwind": {"path": "$u", "preserveNullAndEmptyArrays": True}},
                        {
                "$lookup": {
                    "from": COL_PREFS,
                    "let": {"fid": "$faculty_id"},
                    "pipeline": [
                        {
                            # All prefs for this faculty
                            "$match": {
                                "$expr": {"$eq": [{"$toString": "$faculty_id"}, {"$toString": "$$fid"}]},
                            }
                        },
                        {
                            # Flag rows that belong to the active term (if we have one)
                            "$addFields": {
                                "_is_active_term": {
                                    "$cond": [
                                        {
                                            "$and": [
                                                {"$ne": [active_term_id_str, None]},
                                                {"$eq": [{"$toString": "$term_id"}, active_term_id_str]},
                                            ]
                                        },
                                        1,
                                        0,
                                    ]
                                }
                            }
                        },
                        {
                            # Prefer active-term row, then latest submission
                            "$sort": {
                                "_is_active_term": -1,
                                "submitted_at": -1,
                                "_id": -1,
                            }
                        },
                        {
                            # We only ever want one doc per faculty
                            "$limit": 1
                        },
                        {
                            "$project": {
                                "_id": 0,
                                "term_id": 1,
                                "_is_active_term": 1,
                                "preferred_units": 1,
                                "on_break": 1,
                            }
                        },

                    ],
                    "as": "pref",
                }
            },
            # Take the first (and only) element from the lookup array; null if none
            {"$addFields": {"pref": {"$first": "$pref"}}},

            {"$addFields": {
                "department_display": _dept_name_expr(),
                "name": _full_name_expr(),
                "email_display": {"$ifNull": ["$u.email", "$email"]},
                "user_id_display": {"$ifNull": ["$u.user_id", "$user_id"]},
                "status_display": {
                    "$cond": [
                        {
                            "$and": [
                                {"$eq": ["$pref._is_active_term", 1]},
                                {"$eq": ["$pref.on_break", True]},
                            ]
                        },
                        "On Leave",
                        {
                            "$cond": [
                                {"$eq": ["$u.status", True]},
                                "Active",
                                "On Leave",
                            ]
                        },
                    ]
                },
                "faculty_type_display": {
                    "$switch": {
                        "branches": [
                            {"case": {"$eq": ["$employment_type", "FT"]}, "then": "Full-Time"},
                            {"case": {"$eq": ["$employment_type", "PT"]}, "then": "Part-Time"},
                        ],
                        "default": {"$ifNull": ["$employment_type", ""]},
                    }
                },
                "teaching_units_display": {"$cond": [{"$eq": ["$pref._is_active_term", 1]}, {"$ifNull": ["$pref.preferred_units", "N/A"]}, "N/A"]},
            }},
            {"$match": {"$expr": {"$or": [
                {"$eq": [dept_filter, ""]},
                {"$eq": ["$department_display", dept_filter]}
            ]}}}
        ]

        if search and search.strip():
            s = search.strip()
            pipeline.append({"$match": {"$or": [
                {"name": {"$regex": s, "$options": "i"}},
                {"email_display": {"$regex": s, "$options": "i"}},
                {"user_id": {"$regex": s, "$options": "i"}},
            ]}})

        pipeline.extend([
            {"$project": {
                "_id": 0,
                "faculty_id": 1,
                "name": 1,
                "user_id": "$user_id_display",
                "email": "$email_display",
                "department": "$department_display",
                "position": {"$ifNull": ["$position", {"$ifNull": ["$fac_position", ""]}]},
                "teaching_units": "$teaching_units_display",
                "faculty_type": "$faculty_type_display",
                "status": "$status_display",
                "certifications": {"$ifNull": ["$certifications", []]},
                "hire_date": {"$ifNull": ["$hire_date", None]},
                "teaching_years": {"$ifNull": ["$teaching_years", None]},
            }},
            {"$sort": {"name": 1}},
        ])

        rows = [r async for r in db[COL_FACULTY].aggregate(pipeline)]

        # Normalize lightweight profile fields for table display
        for r in rows:
            r["certifications"] = _normalize_certifications(r.get("certifications"))

            hd = _normalize_hire_date(r.get("hire_date"))
            r["hire_date"] = hd

            ty = _coerce_int(r.get("teaching_years"))
            if ty is None:
                ty = _teaching_years_from_hire_date(hd)
            r["teaching_years"] = ty

        return {"ok": True, "rows": rows}

# ----- DETAILS (View More Details) -----
    if action == "details":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")

        fac = await db[COL_FACULTY].find_one(
            {"faculty_id": facultyId},
            {
                "_id": 0,
                "faculty_id": 1,
                "user_id": 1,
                "email": 1,
                "department_id": 1,
                "employment_type": 1,
                "certifications": 1,
                "hire_date": 1,
                "teaching_years": 1,
            },
        )
        if not fac:
            raise HTTPException(status_code=404, detail="Faculty profile not found.")

        # User info (prefer user_id; fall back to email)
        user = None
        if fac.get("user_id"):
            user = await db[COL_USERS].find_one(
                {"user_id": fac.get("user_id")},
                {"_id": 0, "first_name": 1, "last_name": 1, "email": 1},
            )
        if not user and fac.get("email"):
            user = await db[COL_USERS].find_one(
                {"email": fac.get("email")},
                {"_id": 0, "first_name": 1, "last_name": 1, "email": 1},
            )

        first_name = (user or {}).get("first_name") or ""
        last_name = (user or {}).get("last_name") or ""
        email = (user or {}).get("email") or fac.get("email") or ""

        dept_name = ""
        if fac.get("department_id"):
            dept = await db[COL_DEPARTMENTS].find_one(
                {"department_id": fac.get("department_id")},
                {"_id": 0, "department_name": 1, "dept_name": 1},
            )
            dept_name = ((dept or {}).get("department_name") or (dept or {}).get("dept_name") or "").strip()

        et = str(fac.get("employment_type") or "").strip().upper()
        faculty_type = ("Full-Time" if et == "FT" else "Part-Time" if et == "PT" else et)

        certifications = _normalize_certifications(fac.get("certifications"))
        hire_date = _normalize_hire_date(fac.get("hire_date"))
        teaching_years = _teaching_years_from_hire_date(hire_date) if hire_date else _coerce_int(fac.get("teaching_years"))

        # Deloading for working/active term (same logic as CHAIR Edit Faculty Details)
        active = await _active_term()
        term_id = (active or {}).get("term_id")
        deloading = None
        term_label = None
        if term_id:
            term_label = None
            try:
                ay = active.get("acad_year_start")
                tn = active.get("term_number")
                if ay is not None and tn is not None:
                    term_label = f"AY {ay}-{ay + 1} · Term {tn}"
            except Exception:
                term_label = None

            dl_list = await db[COL_DELOADINGS].find(
                {"term_id": term_id, "faculty_id": facultyId},
                {"_id": 0, "type_id": 1, "deloadingtype_id": 1, "units_deloaded": 1, "notes": 1, "deloading_notes": 1, "updated_at": 1},
            ).sort([("updated_at", -1), ("_id", -1)]).to_list(1)

            d = (dl_list or [None])[0]
            if d:
                type_id_val = (d.get("type_id") or d.get("deloadingtype_id") or "").strip() or None
                dt = None
                if type_id_val:
                    dt = await db[COL_DELOADING_TYPES].find_one(
                        {"$or": [{"type_id": type_id_val}, {"deloadingtype_id": type_id_val}]},
                        {"_id": 0, "type": 1},
                    )
                deloading = {
                    "type_id": type_id_val,
                    "deloading_type": (dt or {}).get("type"),
                    "units_deloaded": d.get("units_deloaded"),
                    "notes": (d.get("notes") or d.get("deloading_notes") or "").strip() or None,
                    "term_id": term_id,
                    "term_label": term_label,
                    "updated_at": d.get("updated_at"),
                }

        return {
            "ok": True,
            "faculty_id": facultyId,
            "details": {
                "first_name": first_name,
                "last_name": last_name,
                "email": email,
                "department": dept_name,
                "faculty_type": faculty_type,
                "certifications": certifications,
                "hire_date": hire_date,
                "teaching_years": teaching_years,
            },
            "deloading": deloading,
        }

        # ----- SCHEDULE: current/selected term sections (reuse FACULTY_Overview logic) -----
    if action == "schedule":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")

        fid_str = str(facultyId)
        match_ids = await _resolve_faculty_match_ids(fid_str)
        if not match_ids:
            match_ids = [fid_str]

        # Resolve term if not provided.
        # UI requirement: show the *latest* schedule the faculty has in the DB (no prev/next navigation).
        # So, by default, pick the most recent term where the faculty has assignments.
        if not termId:
            latest_terms = await _faculty_terms(fid_str)
            if latest_terms:
                termId = latest_terms[-1].get("term_id")
            else:
                # Fall back to current/active term if the faculty has no assignments yet.
                current = await _current_term()
                termId = current.get("term_id") if current else None
                if not termId:
                    active = await _active_term()
                    termId = active.get("term_id")

        # faculty_assignments -> sections (filter by term) -> courses -> section_schedules
        # NOTE: Do NOT filter archived rows here. Faculty Management schedule/history
        # views are read-only and should show past terms as well.
        pipeline: List[Dict[str, Any]] = [
            {"$match": {"$expr": {"$and": [ {"$in": [{"$toString": "$faculty_id"}, match_ids]} ]}}},
            {"$lookup": {"from": COL_SECTIONS, "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
            {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
        ]

        term_id_str = str(termId) if termId is not None else None
        if term_id_str:
            pipeline.append({"$match": {"$expr": {"$eq": [{"$toString": "$sec.term_id"}, term_id_str]}}})

        pipeline.extend([
            {"$lookup": {"from": COL_COURSES, "localField": "sec.course_id", "foreignField": "course_id", "as": "course"}},
            {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": "section_schedules", "localField": "sec.section_id", "foreignField": "section_id", "as": "sched"}},
            {"$unwind": {"path": "$sched", "preserveNullAndEmptyArrays": True}},

            {"$addFields": {
                "course_code_display": {
                    "$cond": [
                        {"$isArray": "$course.course_code"},
                        {"$ifNull": [{"$arrayElemAt": ["$course.course_code", 0]}, ""]},
                        {"$ifNull": ["$course.course_code", ""]},
                    ]
                }
            }},

            {"$project": {
                "_id": 0,
                "section_id": "$sec.section_id",
                "section": "$sec.section_code",
                "course_code": "$course_code_display",
                "course_title": "$course.course_title",
                "units": {"$ifNull": ["$course.units", 0]},
                "sched_day": "$sched.day",
                "sched_start": "$sched.start_time",
                "sched_end": "$sched.end_time",
                "section_remarks": "$sec.remarks",
            }},

            {"$group": {
                "_id": "$section_id",
                "section": {"$first": "$section"},
                "course_code": {"$first": "$course_code"},
                "course_title": {"$first": "$course_title"},
                "units": {"$first": "$units"},
                "section_remarks": {"$first": "$section_remarks"},
                "meetings": {"$push": {
                    "day": "$sched_day",
                    "start": "$sched_start",
                    "end": "$sched_end",
                    
                }},
            }},
        ])

        raw_rows = [r async for r in db[COL_ASSIGNMENTS].aggregate(pipeline)]

        # Flatten: 1 row per section, up to 2 meetings (Day/Begin/End)
        day_order = _DAY_INITIAL_ORDER

        out_rows: List[Dict[str, Any]] = []
        for r in raw_rows:
            meets = r.get("meetings") or []

            norm = []
            for m in meets:
                if not (m.get("day") or m.get("start") or m.get("end")):
                    continue
                day = _to_day_initial(m.get("day"))
                begin = _fmt_hhmm(m.get("start"))
                end = _fmt_hhmm(m.get("end"))
                norm.append((day_order.get(day, 99), begin, {
                    "day": day,
                    "begin": begin,
                    "end": end,
                                    }))

            norm.sort(key=lambda x: (x[0], x[1] or ""))

            day1 = begin1 = end1 = day2 = begin2 = end2 = ""
            mode_val = _extract_mode_from_remarks(r.get("section_remarks"))
            if norm:
                day1 = norm[0][2]["day"]
                begin1 = norm[0][2]["begin"]
                end1 = norm[0][2]["end"]
            if len(norm) > 1:
                day2 = norm[1][2]["day"]
                begin2 = norm[1][2]["begin"]
                end2 = norm[1][2]["end"]

            code = r.get("course_code") or ""
            if isinstance(code, list):
                code = " / ".join(str(x) for x in code if x).strip()

            out_rows.append({
                "course_code": code,
                "course_title": r.get("course_title") or "",
                "section": r.get("section") or "",
                "mode": mode_val,
                "units": r.get("units", 0) or 0,
                "day1": day1,
                "begin1": begin1,
                "end1": end1,
                "day2": day2,
                "begin2": begin2,
                "end2": end2,
            })

        out_rows.sort(key=lambda x: (x.get("course_code") or "", x.get("section") or ""))

        # Build term navigation metadata for UI (Prev/Next Term header)
        current_term = await _current_term()
        active_term_id = current_term.get("term_id") if current_term else None

        terms = await _faculty_terms(fid_str)
        term_id_str = str(termId) if termId is not None else ""

        # Ensure the selected term is included even if it has zero rows
        if term_id_str and all(str(t.get("term_id")) != term_id_str for t in terms):
            tdoc = await db[COL_TERMS].find_one(
                {"$expr": {"$eq": [{"$toString": "$term_id"}, term_id_str]}},
                {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
            )
            if tdoc:
                terms.append(tdoc)
            else:
                terms.append({"term_id": termId, "acad_year_start": None, "term_number": None})

            def _k(t: Dict[str, Any]):
                ay = t.get("acad_year_start")
                try:
                    ay = int(ay)
                except Exception:
                    ay = 9999
                tn = t.get("term_number")
                try:
                    tn = int(tn)
                except Exception:
                    tn = 99
                return (ay, tn, str(t.get("term_id") or ""))

            terms.sort(key=_k)

        active_term_id_str = str(active_term_id) if active_term_id is not None else ""
        for t in terms:
            t["is_active"] = bool(active_term_id_str) and (str(t.get("term_id")) == active_term_id_str)

        term_index = 0
        for i, t in enumerate(terms):
            if term_id_str and str(t.get("term_id")) == term_id_str:
                term_index = i
                break

        term_doc = terms[term_index] if terms else {"term_id": termId, "acad_year_start": None, "term_number": None, "is_active": False}

        return {
            "ok": True,
            "term_id": termId,
            "term": {"term_id": term_doc.get("term_id"), "acad_year_start": term_doc.get("acad_year_start"), "term_number": term_doc.get("term_number")},
            "active_term_id": active_term_id,
            "terms": [{"term_id": t.get("term_id"), "acad_year_start": t.get("acad_year_start"), "term_number": t.get("term_number"), "is_active": t.get("is_active", False)} for t in terms],
            "term_index": term_index,
            "teaching_load": out_rows,
        }

    # ----- HISTORY: per AY grouped by term -----
    # ----- HISTORY: per AY grouped by term -----
    if action == "history":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")

        fid_str = str(facultyId)
        match_ids = await _resolve_faculty_match_ids(fid_str)
        if not match_ids:
            match_ids = [fid_str]

        # Default AY = most recent AY *with data* for this faculty
        ay_list = await _faculty_academic_years(fid_str)
        if not ay_list:
            return {"ok": True, "acad_year_start": None, "academicYears": [], "terms": {}}

        if acadYearStart is None or acadYearStart not in ay_list:
            acadYearStart = ay_list[0]

        # Build like FACULTY_History: assign -> section -> course -> term -> schedules -> room -> campus
        # NOTE: Do NOT filter archived rows for history (matches Reports & Analytics behavior).
        pipeline = [
            {"$match": {"$expr": {"$and": [ {"$in": [{"$toString": "$faculty_id"}, match_ids]} ]}}},
            {"$lookup": {"from": "sections", "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
            {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": "courses", "localField": "sec.course_id", "foreignField": "course_id", "as": "course"}},
            {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {
                "from": "terms",
                "let": {"tid": "$sec.term_id"},
                "pipeline": [
                    {"$match": {"$expr": {"$eq": [
                        {"$toString": "$term_id"},
                        {"$toString": "$$tid"},
                    ]}}},
                    {"$project": {"_id": 0, "term_number": 1, "acad_year_start": 1}},
                ],
                "as": "t"
            }},
            {"$unwind": {"path": "$t", "preserveNullAndEmptyArrays": True}},
            # Filter by AY via joined terms (not on the assignment doc)
            {"$match": {"t.acad_year_start": acadYearStart}},
            # schedules fan-out
            {"$lookup": {"from": "section_schedules", "localField": "sec.section_id", "foreignField": "section_id", "as": "scheds"}},
            {"$unwind": {"path": "$scheds", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": "rooms", "localField": "scheds.room_id", "foreignField": "room_id", "as": "room"}},
            {"$unwind": {"path": "$room", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": "campuses", "localField": "room.campus_id", "foreignField": "campus_id", "as": "camp"}},
            {"$unwind": {"path": "$camp", "preserveNullAndEmptyArrays": True}},
            {"$project": {
                "_id": 0,
                "section_id": "$sec.section_id",
                "section_code": "$sec.section_code",
                "course_code_raw": "$course.course_code",
                "course_title": "$course.course_title",
                "units": {"$ifNull": ["$course.units", 0]},
                "term_number": "$t.term_number",
                "sched_day": "$scheds.day",
                "sched_room_type": "$scheds.room_type",
                "sched_start": "$scheds.start_time",
                "sched_end": "$scheds.end_time",
                "room_number": "$room.room_number",
                "campus_name": "$camp.campus_name",
            }},
            # Group back to section and collect meetings (sorted later)
            {"$group": {
                "_id": "$section_id",
                "section_code": {"$first": "$section_code"},
                "course_code_raw": {"$first": "$course_code_raw"},
                "course_title": {"$first": "$course_title"},
                "units": {"$first": "$units"},
                "term_number": {"$first": "$term_number"},
                "meetings": {"$push": {
                    "day": "$sched_day",
                    "room_type": "$sched_room_type",
                    "start": "$sched_start",
                    "end": "$sched_end",
                    "room": "$room_number",
                    "campus": "$campus_name",
                }},
            }},
        ]
        day_order = _DAY_INITIAL_ORDER

        rows = [r async for r in db[COL_ASSIGNMENTS].aggregate(pipeline)]

        # Section → flat UI row (take up to 2 meetings, sorted by day)
        flat = []
        for r in rows:
            meets = r.get("meetings") or []
            norm = []
            for m in meets:
                if not (m.get("day") or m.get("start") or m.get("end")):
                    continue
                day = _to_day_initial(m.get("day"))
                begin = _fmt_hhmm(m.get("start"))
                end = _fmt_hhmm(m.get("end"))
                norm.append((day_order.get(day, 99), begin, {
                    "day": day,
                    "begin": begin,
                    "end": end,
                }))
            norm.sort(key=lambda x: (x[0], x[1] or ""))

            day1 = begin1 = end1 = day2 = begin2 = end2 = None
            if norm:
                day1 = norm[0][2]["day"]
                begin1 = norm[0][2]["begin"]
                end1 = norm[0][2]["end"]
            if len(norm) > 1:
                day2 = norm[1][2]["day"]
                begin2 = norm[1][2]["begin"]
                end2 = norm[1][2]["end"]

            # normalize course code if array
            code = r.get("course_code_raw")
            if isinstance(code, list):
                code = (code[0] if code else "") or ""

            tn = r.get("term_number")
            try:
                            tn_int = int(tn) if tn is not None else None
            except Exception:
                            tn_int = None
            tn_norm = tn_int if tn_int in (1, 2, 3) else 1
            term_label = f"Term {tn_norm}"

            flat.append({
                            "term": term_label,
                            "term_number": tn_norm,
                            "code": code or "",
                            "title": r.get("course_title") or "",
                            "section": r.get("section_code") or "",
                            "units": r.get("units", 0) or 0,
                            "day1": day1 or "",
                            "begin1": begin1 or "",
                            "end1": end1 or "",
                            "day2": day2 or "",
                            "begin2": begin2 or "",
                            "end2": end2 or "",
                        })

                # Sort and group by term for OM payload → { terms: { "Term 1": [...] } }
        flat.sort(key=lambda x: (x.get("term_number", 1), x.get("code") or "", x.get("section") or ""))

        grouped = {"Term 1": [], "Term 2": [], "Term 3": []}
        for r in flat:
            term = r.get("term") or "Term 1"
            if term not in grouped:
                term = "Term 1"
            grouped[term].append({
                "code": r["code"],
                "title": r["title"],
                "section": r["section"],
                "units": r.get("units", 0),
                "day1": r.get("day1"),
                "begin1": r.get("begin1"),
                "end1": r.get("end1"),
                "day2": r.get("day2"),
                "begin2": r.get("begin2"),
                "end2": r.get("end2"),
            })

        return {"ok": True, "acad_year_start": acadYearStart, "academicYears": ay_list, "terms": grouped}


    raise HTTPException(status_code=400, detail="Invalid action parameter.")
