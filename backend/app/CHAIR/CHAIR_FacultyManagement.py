from typing import Any, Dict, List, Optional, Tuple
from fastapi import APIRouter, HTTPException, Query, Body
from datetime import datetime, timezone
import re

from ..main import db

router = APIRouter(prefix="/chair", tags=["chair"])

# ---------- Collections ----------
COL_USERS = "users"
COL_FACULTY = "faculty_profiles"
COL_DEPARTMENTS = "departments"
COL_TERMS = "terms"
COL_SECTIONS = "sections"
COL_ASSIGNMENTS = "faculty_assignments"
COL_PREFS = "faculty_preferences"
COL_ROLE_ASSIGN = "role_assignments"
COL_USER_ROLES = "user_roles"
COL_COURSES = "courses"
COL_PREEN_COUNT = "preenlistment_count"
COL_CAMPUSES = "campuses"

# Deloading collections (shared with OM Load Assignment)
COL_DELOADINGS = "deloadings"
COL_DELOADING_TYPES = "deloading_types"

WEEKDAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

# ---------- Day / time helpers ----------
# Updated to include single letter codes (M, T, W, H, F, S)
_DAY_MAP = {
    "M": "Monday", "MON": "Monday",
    "T": "Tuesday", "TU": "Tuesday", "TUE": "Tuesday",
    "W": "Wednesday", "WED": "Wednesday",
    "TH": "Thursday", "THU": "Thursday", "R": "Thursday", "H": "Thursday",
    "F": "Friday", "FRI": "Friday",
    "S": "Saturday", "SAT": "Saturday",
}
DAY_ORDER_MAP = {"Monday": 1, "Tuesday": 2, "Wednesday": 3, "Thursday": 4, "Friday": 5, "Saturday": 6}

# Day initials expected by the OM-style Schedule/History tables (M/T/W/H/F/S)
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
        remarks = " ".join(str(v) for v in remarks.values() if v)

    if isinstance(remarks, list):
        remarks = " ".join(str(x) for x in remarks if x)

    s = str(remarks).strip()
    if not s:
        return "Online"

    up = s.upper()
    if "HYBRID" in up:
        return "Hybrid"
    if "F2F" in up or "FTF" in up or "FACE" in up:
        return "F2F"
    if "FOL" in up or "ONLINE" in up or "ONL" in up:
        return "Online"
    return s



def _to_full_day(day_val: str) -> str:
    s = (day_val or "").strip().upper()
    return _DAY_MAP.get(s, (day_val or "").strip() or "")



def _fmt_hhmm(raw: Any) -> str:
    if raw is None:
        return ""
    s = str(raw).strip()
    if ":" in s:
        return s
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



def _ay_label(ay_start: Optional[int]) -> str:
    if ay_start is None:
        return "AY —"
    try:
        n = int(ay_start)
        return f"AY {n}-{n + 1}"
    except Exception:
        return "AY —"



def _code_as_str(v: Any) -> str:
    if isinstance(v, list):
        return (v[0] if v else "") or ""
    return str(v or "")


# ---------- Campus Fallback Helper ----------
async def _dept_fallback_campus_name(department_id: Optional[str]) -> Optional[str]:
    if not department_id:
        return None
    dept = await db[COL_DEPARTMENTS].find_one({"department_id": department_id}, {"_id": 0, "campus_id": 1})
    campus_ids = (dept or {}).get("campus_id") or []
    first = campus_ids[0] if isinstance(campus_ids, list) and campus_ids else None
    if not first:
        return None
    camp = await db[COL_CAMPUSES].find_one({"campus_id": first}, {"_id": 0, "campus_name": 1})
    return (camp or {}).get("campus_name")


# ---------- Small helpers for IDs & coercion ----------

async def _next_id(collection_name: str, field: str, prefix: str) -> str:
    coll = db[collection_name]
    cursor = coll.find(
        {field: {"$regex": f"^{re.escape(prefix)}[0-9]+$"}},
        {field: 1, "_id": 0},
    ).sort(field, -1).limit(1)
    docs = [d async for d in cursor]
    if docs:
        last = str(docs[0].get(field, "") or "")
        num_part = "".join(ch for ch in last if ch.isdigit())
        try:
            n = int(num_part)
        except (TypeError, ValueError):
            n = 0
    else:
        n = 0
    return f"{prefix}{n + 1:04d}"



def _normalize_certifications(raw: Any) -> List[str]:
    if raw is None:
        return []
    parts: List[str] = []
    if isinstance(raw, list):
        for item in raw:
            for piece in str(item or "").split(","):
                parts.append(piece)
    else:
        for piece in str(raw or "").split(","):
            parts.append(piece)
    return [p.strip() for p in parts if p and p.strip()]



def _coerce_int(val: Any) -> Optional[int]:
    if val is None or val == "":
        return None
    try:
        return int(val)
    except (TypeError, ValueError):
        return None



def _teaching_years_from_hire_date(hire_date_raw: Any) -> Optional[int]:
    """Compute whole-year teaching years from a hire/start date.

    Expected input: 'YYYY-MM-DD' (from HTML date input). Returns an int >= 0.
    """
    if hire_date_raw is None:
        return None
    s = str(hire_date_raw).strip()
    if not s:
        return None
    try:
        hire_dt = datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        return None

    today = datetime.now(timezone.utc).date()
    years = today.year - hire_dt.year
    if (today.month, today.day) < (hire_dt.month, hire_dt.day):
        years -= 1
    return max(0, years)



def _normalize_hire_date(hire_date_raw: Any) -> Optional[str]:
    """Normalize a hire/start date into a YYYY-MM-DD string (or None)."""
    if hire_date_raw is None:
        return None
    s = str(hire_date_raw).strip()
    if not s:
        return None
    try:
        dt = datetime.strptime(s, "%Y-%m-%d").date()
        return dt.isoformat()
    except Exception:
        return None




async def _resolve_faculty_match_ids(faculty_id_or_user_id: str) -> List[str]:
    """Return identifiers that may appear in faculty_assignments.faculty_id.

    Legacy datasets may store either faculty_profiles.faculty_id OR users.user_id.
    Resolve both so schedule/history remains consistent with OM Faculty Management.
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

    email = None
    if fac and fac.get("email"):
        email = str(fac.get("email") or "").strip().lower()
    elif "@" in base:
        email = base.strip().lower()

    if email:
        user = await db[COL_USERS].find_one({"email": email}, {"_id": 0, "user_id": 1})
        if user and user.get("user_id"):
            ids.append(str(user.get("user_id")))

    out: List[str] = []
    seen = set()
    for x in ids:
        val = (str(x) if x is not None else "").strip()
        if not val or val in seen:
            continue
        seen.add(val)
        out.append(val)
    return out


async def _faculty_academic_years(fid_str: str) -> List[int]:
    """Return academic years where the faculty has teaching assignments.

    Include archived assignments because past teaching history is commonly stored
    that way.
    """
    if not fid_str:
        return []

    match_ids = await _resolve_faculty_match_ids(fid_str)
    if not match_ids:
        match_ids = [fid_str]

    pipeline: List[Dict[str, Any]] = [
        {"$match": {"$expr": {"$in": [{"$toString": "$faculty_id"}, match_ids]}}},
        {"$lookup": {"from": COL_SECTIONS, "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
        {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": False}},
        {"$lookup": {
            "from": COL_TERMS,
            "let": {"tid": "$sec.term_id"},
            "pipeline": [
                {"$match": {"$expr": {"$eq": [{"$toString": "$term_id"}, {"$toString": "$$tid"}]}}},
                {"$project": {"_id": 0, "acad_year_start": 1}},
            ],
            "as": "t",
        }},
        {"$unwind": {"path": "$t", "preserveNullAndEmptyArrays": False}},
        {"$match": {"t.acad_year_start": {"$ne": None}}},
        {"$group": {"_id": "$t.acad_year_start"}},
        {"$project": {"_id": 0, "acad_year_start": "$_id"}},
        {"$sort": {"acad_year_start": -1}},
    ]

    years: List[int] = []
    async for row in db[COL_ASSIGNMENTS].aggregate(pipeline, allowDiskUse=True):
        try:
            years.append(int(row.get("acad_year_start")))
        except Exception:
            continue
    return sorted(set(years), reverse=True)

async def _sync_role_assignment_department_scope(user_id: Optional[str], department_id: Optional[str]) -> None:
    if not user_id or not department_id:
        return

    cursor = db[COL_ROLE_ASSIGN].find({"user_id": user_id}, {"_id": 1, "scope": 1})
    docs = await cursor.to_list(length=None)
    for doc in docs:
        scope = doc.get("scope") or []
        if not isinstance(scope, list):
            scope = []

        next_scope: List[Dict[str, Any]] = []
        replaced = False
        for item in scope:
            if isinstance(item, dict) and item.get("type") == "department":
                next_scope.append({"type": "department", "id": department_id})
                replaced = True
            else:
                next_scope.append(item)

        if not replaced:
            next_scope.append({"type": "department", "id": department_id})

        await db[COL_ROLE_ASSIGN].update_one({"_id": doc["_id"]}, {"$set": {"scope": next_scope}})


# ---------- Expression helpers ----------
def _dept_name_expr():
    return {"$ifNull": ["$dept.department_name", "$dept.dept_name"]}



def _full_name_expr():
    return {
        "$trim": {
            "input": {
                "$concat": [
                    {"$ifNull": ["$u.first_name", ""]},
                    " ",
                    {"$ifNull": ["$u.last_name", ""]},
                ]
            }
        }
    }



def _last_first_name_expr():
    return {
        "$trim": {
            "input": {
                "$concat": [
                    {"$ifNull": ["$u.last_name", ""]},
                    {
                        "$cond": [
                            {
                                "$and": [
                                    {"$ne": [{"$ifNull": ["$u.last_name", ""]}, ""]},
                                    {"$ne": [{"$ifNull": ["$u.first_name", ""]}, ""]},
                                ]
                            },
                            ", ",
                            "",
                        ]
                    },
                    {"$ifNull": ["$u.first_name", ""]},
                ]
            }
        }
    }



def _sort_name_part_expr(field_name: str):
    return {
        "$toLower": {
            "$trim": {
                "input": {
                    "$ifNull": [
                        {"$getField": {"field": field_name, "input": "$u"}},
                        "",
                    ]
                }
            }
        }
    }



def _role_display_expr():
    return {"$ifNull": ["$role.role_type", ""]}


async def _active_term() -> Dict[str, Any]:
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

    if not current:
        return {}

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
        return next_terms[0]

    return current


# ---------- Route ----------
@router.post("/facultymanagement")
async def facultymanagement_handler(
    action: str = Query(
        "list",
        description="header | options | list | schedule | history | add | update",
    ),
    userEmail: Optional[str] = Query(None),
    userId: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    facultyType: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    facultyId: Optional[str] = Query(None),
    termId: Optional[str] = Query(None),
    acadYearStart: Optional[int] = Query(None),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    payload = payload or {}

    # ----- HEADER -----
    if action == "header":
        if not userEmail and not userId:
            raise HTTPException(status_code=400, detail="userEmail or userId is required.")

        user_match: Dict[str, Any] = {"user_id": userId} if userId else {"email": userEmail}

        pipeline: List[Dict[str, Any]] = [
            {"$match": user_match},
            {"$project": {"_id": 0, "user_id": 1, "email": 1, "first_name": 1, "last_name": 1}},
            {
                "$lookup": {
                    "from": COL_ROLE_ASSIGN,
                    "localField": "user_id",
                    "foreignField": "user_id",
                    "as": "ra_list",
                }
            },
            {"$unwind": {"path": "$ra_list", "preserveNullAndEmptyArrays": True}},
            {
                "$addFields": {
                    "deptScope": {
                        "$first": {
                            "$filter": {
                                "input": {"$ifNull": ["$ra_list.scope", []]},
                                "as": "s",
                                "cond": {"$eq": ["$$s.type", "department"]},
                            }
                        }
                    },
                    "role_id_from_ra": "$ra_list.role_id",
                }
            },
            {
                "$lookup": {
                    "from": COL_DEPARTMENTS,
                    "localField": "deptScope.id",
                    "foreignField": "department_id",
                    "as": "dept",
                }
            },
            {"$unwind": {"path": "$dept", "preserveNullAndEmptyArrays": True}},
            {
                "$lookup": {
                    "from": COL_USER_ROLES,
                    "localField": "role_id_from_ra",
                    "foreignField": "role_id",
                    "as": "role",
                }
            },
            {"$unwind": {"path": "$role", "preserveNullAndEmptyArrays": True}},
            {
                "$addFields": {
                    "full_name": {
                        "$trim": {
                            "input": {
                                "$concat": [
                                    {"$ifNull": ["$first_name", ""]},
                                    " ",
                                    {"$ifNull": ["$last_name", ""]},
                                ]
                            }
                        }
                    },
                    "dept_name": {"$ifNull": ["$dept.department_name", "$dept.dept_name"]},
                    "role_display": _role_display_expr(),
                }
            },
            {
                "$project": {
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
                    },
                }
            },
            {"$limit": 1},
        ]

        docs = [d async for d in db[COL_USERS].aggregate(pipeline)]
        if not docs:
            return {"ok": False, "message": "User not found."}

        active = await _active_term()
        ay = active.get("acad_year_start")
        tn = active.get("term_number")
        active_term_text = f"Term {tn} · AY {ay}-{ay + 1}" if (ay and tn) else ""

        return {
            "ok": True,
            **docs[0],
            "activeTermText": active_term_text,
        }

    # ----- OPTIONS -----
    if action == "options":
        depts = [d async for d in db[COL_DEPARTMENTS].find({}, {"_id": 0, "department_name": 1, "dept_name": 1})]
        department_options = sorted(
            {
                (d.get("department_name") or d.get("dept_name") or "").strip()
                for d in depts
                if (d.get("department_name") or d.get("dept_name"))
            }
        )

        codes = await db[COL_FACULTY].distinct("employment_type")
        type_map = {"FT": "Full-Time", "PT": "Part-Time"}
        faculty_types = sorted({type_map.get(c, c) for c in codes if c})

        terms_pipeline: List[Dict[str, Any]] = [
            {"$match": {"faculty_id": {"$exists": True}}},
            {"$lookup": {"from": "sections", "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
            {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": "terms", "localField": "sec.term_id", "foreignField": "term_id", "as": "t"}},
            {"$unwind": {"path": "$t", "preserveNullAndEmptyArrays": True}},
            {"$project": {"_id": 0, "ay": "$t.acad_year_start"}},
            {"$group": {"_id": "$ay"}},
        ]
        vals = [r async for r in db[COL_ASSIGNMENTS].aggregate(terms_pipeline)]
        ay_list = sorted({int(r["_id"]) for r in vals if isinstance(r.get("_id"), int)}, reverse=True)

        active_term_obj = await _active_term()

        return {
            "ok": True,
            "departments": department_options,
            "facultyTypes": faculty_types,
            "academicYears": ay_list,
            "activeTerm": active_term_obj,
        }

    # ----- DELOADING (VIEW + UPDATE) -----
    if action == "deloading_get":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")

        active = await _active_term()
        term_id = (termId or "").strip() or (active or {}).get("term_id")
        if not term_id:
            return {"ok": True, "term_id": None, "faculty_id": facultyId, "current": None, "types": []}

        types_docs = [
            t
            async for t in db[COL_DELOADING_TYPES].find(
                {}, {"_id": 0, "type_id": 1, "deloadingtype_id": 1, "type": 1}
            ).sort([("type", 1)])
        ]
        types = [
            {
                "type_id": (t.get("type_id") or t.get("deloadingtype_id") or "").strip(),
                "type": (t.get("type") or "").strip(),
            }
            for t in (types_docs or [])
            if (t.get("type_id") or t.get("deloadingtype_id")) and (t.get("type") or "").strip()
        ]

        dl_list = await db[COL_DELOADINGS].find(
            {"term_id": term_id, "faculty_id": facultyId},
            {
                "_id": 0,
                "type_id": 1,
                "units_deloaded": 1,
                "notes": 1,
                "deloading_notes": 1,
                "updated_at": 1,
            },
        ).sort([("updated_at", -1), ("_id", -1)]).to_list(1)
        d = (dl_list or [None])[0]
        current = None
        if d:
            type_id_val = (d.get("type_id") or "").strip() if d.get("type_id") else None
            dt = None
            if type_id_val:
                dt = await db[COL_DELOADING_TYPES].find_one(
                    {"$or": [{"type_id": type_id_val}, {"deloadingtype_id": type_id_val}]},
                    {"_id": 0, "type": 1},
                )
            current = {
                "type_id": type_id_val,
                "deloading_type": (dt or {}).get("type"),
                "units_deloaded": d.get("units_deloaded"),
                "notes": (d.get("notes") or d.get("deloading_notes") or "").strip() or None,
                "term_id": term_id,
                "updated_at": d.get("updated_at"),
            }

        return {"ok": True, "term_id": term_id, "faculty_id": facultyId, "current": current, "types": types}

    if action == "deloading_update":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")

        active = await _active_term()
        term_id = (termId or "").strip() or (active or {}).get("term_id")
        if not term_id:
            return {"ok": True, "term_id": None, "faculty_id": facultyId}

        type_id = payload.get("type_id")
        if type_id is not None:
            type_id = str(type_id).strip()
            if not type_id:
                type_id = None

        notes_val = payload.get("notes")
        notes_clean: Optional[str] = None
        if notes_val is not None:
            notes_clean = str(notes_val).strip() or None

        units_val = payload.get("units_deloaded")
        units_deloaded: Optional[float] = None
        if units_val is not None:
            try:
                if str(units_val).strip() == "":
                    units_deloaded = None
                else:
                    units_deloaded = float(units_val)
                    if units_deloaded < 0:
                        raise ValueError("units_deloaded must be >= 0")
            except Exception:
                raise HTTPException(status_code=422, detail="Invalid units_deloaded.")

        existing_list = await db[COL_DELOADINGS].find(
            {"term_id": term_id, "faculty_id": facultyId},
            {"_id": 1},
        ).sort([("updated_at", -1), ("_id", -1)]).to_list(1)
        existing = (existing_list or [None])[0]

        now = datetime.now(timezone.utc)
        set_fields: Dict[str, Any] = {"updated_at": now}
        unset_fields: Dict[str, Any] = {}

        if type_id is not None:
            set_fields["type_id"] = type_id
        elif payload.get("type_id") is not None:
            unset_fields["type_id"] = ""

        if units_val is not None:
            if units_deloaded is None:
                unset_fields["units_deloaded"] = ""
            else:
                set_fields["units_deloaded"] = units_deloaded

        if notes_val is not None:
            if notes_clean is None:
                unset_fields["notes"] = ""
                unset_fields["deloading_notes"] = ""
            else:
                set_fields["notes"] = notes_clean
                set_fields["deloading_notes"] = notes_clean

        if existing:
            update_doc: Dict[str, Any] = {"$set": set_fields}
            if unset_fields:
                update_doc["$unset"] = unset_fields
            await db[COL_DELOADINGS].update_one({"_id": existing["_id"]}, update_doc)
        else:
            doc: Dict[str, Any] = {"term_id": term_id, "faculty_id": facultyId, "updated_at": now}
            if type_id is not None:
                doc["type_id"] = type_id
            if units_val is not None and units_deloaded is not None:
                doc["units_deloaded"] = units_deloaded
            if notes_val is not None and notes_clean is not None:
                doc["notes"] = notes_clean
                doc["deloading_notes"] = notes_clean
            if len(doc.keys()) > 3:
                await db[COL_DELOADINGS].insert_one(doc)

        return {"ok": True, "term_id": term_id, "faculty_id": facultyId}

    # ----- LIST -----
    if action == "list":
        active = await _active_term()
        active_term_id = active.get("term_id")

        early_match: Dict[str, Any] = {}
        if facultyType and facultyType.strip().lower() != "all type":
            code = {"Full-Time": "FT", "Part-Time": "PT"}.get(facultyType.strip())
            if code:
                early_match["employment_type"] = code

        dept_filter = (department or "").strip()
        if dept_filter.lower() == "all departments":
            dept_filter = ""

        status_filter = (status or "").strip()
        if status_filter.lower() in ["all status", "all", ""]:
            status_filter = ""

        pipeline = [
            {"$match": early_match},
            {
                "$lookup": {
                    "from": COL_DEPARTMENTS,
                    "localField": "department_id",
                    "foreignField": "department_id",
                    "as": "dept",
                }
            },
            {"$unwind": {"path": "$dept", "preserveNullAndEmptyArrays": True}},
            {
                "$lookup": {
                    "from": COL_USERS,
                    "let": {"uid": "$user_id", "femail": "$email"},
                    "pipeline": [
                        {
                            "$match": {
                                "$expr": {
                                    "$or": [
                                        {"$and": [{"$ne": ["$$uid", None]}, {"$eq": ["$user_id", "$$uid"]}]},
                                        {"$and": [{"$ne": ["$$femail", None]}, {"$eq": ["$email", "$$femail"]}]},
                                    ]
                                }
                            }
                        },
                        {"$project": {"_id": 0, "first_name": 1, "last_name": 1, "status": 1, "email": 1}},
                    ],
                    "as": "u",
                }
            },
            {"$unwind": {"path": "$u", "preserveNullAndEmptyArrays": True}},
            {
                "$lookup": {
                    "from": COL_PREFS,
                    "let": {"fid": "$faculty_id"},
                    "pipeline": [
                        {"$match": {"$expr": {"$eq": ["$faculty_id", "$$fid"]}}},
                        {
                            "$addFields": {
                                "_is_active_term": {
                                    "$cond": [
                                        {
                                            "$and": [
                                                {"$ne": [active_term_id, None]},
                                                {"$eq": ["$term_id", active_term_id]},
                                            ]
                                        },
                                        1,
                                        0,
                                    ]
                                }
                            }
                        },
                        {"$sort": {"_is_active_term": -1, "submitted_at": -1, "_id": -1}},
                        {"$limit": 1},
                        {"$project": {"_id": 0, "preferred_units": 1, "on_break": 1}},
                    ],
                    "as": "pref",
                }
            },
            {"$addFields": {"pref": {"$first": "$pref"}}},
            {
                "$addFields": {
                    "department_display": _dept_name_expr(),
                    "name": _full_name_expr(),
                    "display_name": _last_first_name_expr(),
                    "first_name": {"$ifNull": ["$u.first_name", ""]},
                    "last_name": {"$ifNull": ["$u.last_name", ""]},
                    "email_display": {"$ifNull": ["$u.email", "$email"]},
                    "status_display": {
                        "$cond": [
                            {"$eq": ["$pref.on_break", True]},
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
                    "teaching_units_display": {"$ifNull": ["$pref.preferred_units", "N/A"]},
                    "sort_department": {
                        "$toLower": {"$trim": {"input": {"$ifNull": [{"$ifNull": ["$dept.department_name", "$dept.dept_name"]}, ""]}}}
                    },
                    "sort_last_name": _sort_name_part_expr("last_name"),
                    "sort_first_name": _sort_name_part_expr("first_name"),
                }
            },
            {"$match": {"$expr": {"$or": [{"$eq": [dept_filter, ""]}, {"$eq": ["$department_display", dept_filter]}]}}},
            {"$match": {"$expr": {"$or": [{"$eq": [status_filter, ""]}, {"$eq": ["$status_display", status_filter]}]}}},
        ]

        if search and search.strip():
            s = search.strip()
            pipeline.append(
                {
                    "$match": {
                        "$or": [
                            {"name": {"$regex": s, "$options": "i"}},
                            {"email_display": {"$regex": s, "$options": "i"}},
                            {"user_id": {"$regex": s, "$options": "i"}},
                        ]
                    }
                }
            )

        pipeline.extend(
            [
                {
                    "$project": {
                        "_id": 0,
                        "faculty_id": 1,
                        "user_id": 1,
                        "name": 1,
                        "display_name": 1,
                        "first_name": 1,
                        "last_name": 1,
                        "email": "$email_display",
                        "department": "$department_display",
                        "position": {"$ifNull": ["$position", {"$ifNull": ["$fac_position", ""]}]},
                        "teaching_units": "$teaching_units_display",
                        "faculty_type": "$faculty_type_display",
                        "status": "$status_display",
                        "certifications": {
                            "$let": {
                                "vars": {"c": {"$ifNull": ["$certifications", []]}},
                                "in": {
                                    "$cond": [
                                        {"$isArray": "$$c"},
                                        "$$c",
                                        {
                                            "$filter": {
                                                "input": {
                                                    "$map": {
                                                        "input": {"$split": ["$$c", ","]},
                                                        "as": "p",
                                                        "in": {"$trim": {"input": "$$p"}},
                                                    }
                                                },
                                                "as": "x",
                                                "cond": {"$ne": ["$$x", ""]},
                                            }
                                        },
                                    ]
                                },
                            }
                        },
                        "teaching_years": {"$ifNull": ["$teaching_years", None]},
                        "hire_date": {"$ifNull": ["$hire_date", None]},
                        "sort_department": 1,
                        "sort_last_name": 1,
                        "sort_first_name": 1,
                    }
                },
                {"$sort": {"sort_department": 1, "sort_last_name": 1, "sort_first_name": 1, "name": 1}},
            ]
        )

        rows = [r async for r in db[COL_FACULTY].aggregate(pipeline)]
        return {"ok": True, "rows": rows}

    # ----- SCHEDULE -----
    if action == "schedule":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")

        active = await _active_term()
        working_term_id = termId or active.get("term_id")
        match_ids = await _resolve_faculty_match_ids(str(facultyId))
        if not match_ids:
            match_ids = [str(facultyId)]

        pipeline: List[Dict[str, Any]] = [
            {"$match": {"$expr": {"$in": [{"$toString": "$faculty_id"}, match_ids]}}},
            {"$lookup": {"from": COL_SECTIONS, "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
            {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
        ]

        if working_term_id:
            pipeline.append({"$match": {"$expr": {"$eq": [{"$toString": "$sec.term_id"}, str(working_term_id)]}}})

        pipeline.extend(
            [
                {"$lookup": {"from": COL_COURSES, "localField": "sec.course_id", "foreignField": "course_id", "as": "course"}},
                {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
                {"$lookup": {"from": "section_schedules", "localField": "sec.section_id", "foreignField": "section_id", "as": "sched"}},
                {"$unwind": {"path": "$sched", "preserveNullAndEmptyArrays": True}},
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
                {
                    "$project": {
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
                    }
                },
                {
                    "$group": {
                        "_id": "$section_id",
                        "section": {"$first": "$section"},
                        "course_code": {"$first": "$course_code"},
                        "course_title": {"$first": "$course_title"},
                        "units": {"$first": "$units"},
                        "section_remarks": {"$first": "$section_remarks"},
                        "meetings": {
                            "$push": {
                                "day": "$sched_day",
                                "start": "$sched_start",
                                "end": "$sched_end",
                            }
                        },
                    }
                },
            ]
        )

        raw_rows = [r async for r in db[COL_ASSIGNMENTS].aggregate(pipeline)]

        out_rows: List[Dict[str, Any]] = []
        for r in raw_rows:
            meets = r.get("meetings") or []

            norm: List[Tuple[int, str, Dict[str, Any]]] = []
            for m in meets:
                if not (m.get("day") or m.get("start") or m.get("end")):
                    continue
                day = _to_day_initial(m.get("day"))
                begin = _fmt_hhmm(m.get("start"))
                end = _fmt_hhmm(m.get("end"))
                norm.append((_DAY_INITIAL_ORDER.get(day, 99), begin, {"day": day, "begin": begin, "end": end}))

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

            out_rows.append(
                {
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
                }
            )

        out_rows.sort(key=lambda x: (x.get("course_code") or "", x.get("section") or ""))

        term_doc = None
        if working_term_id:
            term_doc = await db[COL_TERMS].find_one(
                {"term_id": working_term_id},
                {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
            )

        return {
            "ok": True,
            "term_id": working_term_id,
            "active_term_id": active.get("term_id"),
            "term": term_doc,
            "teaching_load": out_rows,
        }

    # ----- HISTORY -----
    if action == "history":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")

        fid_str = str(facultyId)
        match_ids = await _resolve_faculty_match_ids(fid_str)
        if not match_ids:
            match_ids = [fid_str]

        ay_list = await _faculty_academic_years(fid_str)
        if not ay_list:
            return {"ok": True, "acad_year_start": None, "academicYears": [], "terms": {}, "teaching_history": []}

        if acadYearStart is None or acadYearStart not in ay_list:
            acadYearStart = ay_list[0]

        pipeline = [
            {"$match": {"$expr": {"$in": [{"$toString": "$faculty_id"}, match_ids]}}},
            {"$lookup": {"from": COL_SECTIONS, "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
            {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": COL_COURSES, "localField": "sec.course_id", "foreignField": "course_id", "as": "course"}},
            {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {
                "from": COL_TERMS,
                "let": {"tid": "$sec.term_id"},
                "pipeline": [
                    {"$match": {"$expr": {"$eq": [{"$toString": "$term_id"}, {"$toString": "$$tid"}]}}},
                    {"$project": {"_id": 0, "term_number": 1, "acad_year_start": 1}},
                ],
                "as": "t",
            }},
            {"$unwind": {"path": "$t", "preserveNullAndEmptyArrays": True}},
            {"$match": {"t.acad_year_start": acadYearStart}},
            {"$lookup": {"from": "section_schedules", "localField": "sec.section_id", "foreignField": "section_id", "as": "scheds"}},
            {"$unwind": {"path": "$scheds", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": "rooms", "localField": "scheds.room_id", "foreignField": "room_id", "as": "room"}},
            {"$unwind": {"path": "$room", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": "campuses", "localField": "room.campus_id", "foreignField": "campus_id", "as": "camp"}},
            {"$unwind": {"path": "$camp", "preserveNullAndEmptyArrays": True}},
            {
                "$project": {
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
                }
            },
            {
                "$group": {
                    "_id": "$section_id",
                    "section_code": {"$first": "$section_code"},
                    "course_code_raw": {"$first": "$course_code_raw"},
                    "course_title": {"$first": "$course_title"},
                    "units": {"$first": "$units"},
                    "term_number": {"$first": "$term_number"},
                    "meetings": {
                        "$push": {
                            "day": "$sched_day",
                            "room_type": "$sched_room_type",
                            "start": "$sched_start",
                            "end": "$sched_end",
                            "room": "$room_number",
                            "campus": "$campus_name",
                        }
                    },
                }
            },
        ]

        rows = [r async for r in db[COL_ASSIGNMENTS].aggregate(pipeline)]

        flat: List[Dict[str, Any]] = []
        for r in rows:
            meets = r.get("meetings") or []
            norm: List[Tuple[int, str, Dict[str, Any]]] = []
            for m in meets:
                if not (m.get("day") or m.get("start") or m.get("end")):
                    continue
                day = _to_day_initial(m.get("day"))
                begin = _fmt_hhmm(m.get("start"))
                end = _fmt_hhmm(m.get("end"))
                norm.append((_DAY_INITIAL_ORDER.get(day, 99), begin, {"day": day, "begin": begin, "end": end}))
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

            code = r.get("course_code_raw")
            if isinstance(code, list):
                code = " / ".join(str(x) for x in code if x).strip()
            code = str(code or "")

            term_num = r.get("term_number")
            try:
                term_num = int(term_num) if term_num is not None else None
            except Exception:
                term_num = None
            term_num = term_num if term_num in (1, 2, 3) else 1
            term_label = f"Term {term_num}"

            flat.append(
                {
                    "code": code,
                    "title": r.get("course_title") or "",
                    "section": r.get("section_code") or "",
                    "units": r.get("units") or 0,
                    "day1": day1 or "",
                    "begin1": begin1 or "",
                    "end1": end1 or "",
                    "day2": day2 or "",
                    "begin2": begin2 or "",
                    "end2": end2 or "",
                    "term": term_label,
                }
            )

        flat.sort(key=lambda r: (r.get("term") or "Term 1", r.get("code") or "", r.get("section") or ""))

        terms_out: Dict[str, List[Dict[str, Any]]] = {"Term 1": [], "Term 2": [], "Term 3": []}
        for r in flat:
            tk = r.get("term") or "Term 1"
            if tk not in terms_out:
                tk = "Term 1"
            terms_out[tk].append(
                {
                    "code": r.get("code", ""),
                    "title": r.get("title", ""),
                    "section": r.get("section", ""),
                    "units": r.get("units", 0),
                    "day1": r.get("day1"),
                    "begin1": r.get("begin1"),
                    "end1": r.get("end1"),
                    "day2": r.get("day2"),
                    "begin2": r.get("begin2"),
                    "end2": r.get("end2"),
                }
            )

        return {
            "ok": True,
            "acad_year_start": acadYearStart,
            "academicYears": ay_list,
            "terms": terms_out,
            "teaching_history": flat,
        }

    # ----- ADD -----
    if action == "add":
        first_name = str(payload.get("first_name", "")).strip()
        last_name = str(payload.get("last_name", "")).strip()
        email = str(payload.get("email", "")).strip().lower()
        dept_name = str(payload.get("department", "")).strip()
        employment_type = str(payload.get("employment_type", "")).strip().upper()

        if not first_name or not last_name or not email:
            raise HTTPException(status_code=400, detail="Required fields missing.")
        if employment_type not in {"FT", "PT"}:
            raise HTTPException(status_code=400, detail="Invalid employment type.")

        existing = await db[COL_USERS].find_one({"email": email}, {"_id": 1})
        if existing:
            raise HTTPException(status_code=409, detail="A user with this email already exists.")

        dept_id = "DEPT0001"
        if dept_name:
            dept_doc = await db[COL_DEPARTMENTS].find_one(
                {"$or": [{"department_name": dept_name}, {"dept_name": dept_name}]},
                {"_id": 0, "department_id": 1},
            )
            if dept_doc:
                dept_id = dept_doc["department_id"]

        role_doc = await db[COL_USER_ROLES].find_one({"role_type": "Faculty"})
        if not role_doc:
            raise HTTPException(status_code=500, detail="Faculty role config error.")

        user_id = await _next_id(COL_USERS, "user_id", "USR")
        faculty_id = await _next_id(COL_FACULTY, "faculty_id", "FAC")
        now = datetime.now(timezone.utc)

        await db[COL_USERS].insert_one(
            {
                "user_id": user_id,
                "email": email,
                "first_name": first_name,
                "last_name": last_name,
                "status": True,
                "profile_image": "",
                "created_at": now,
                "last_login": now,
            }
        )

        scope = payload.get("scope") or [
            {"type": "campus", "id": "CMPS0001"},
            {"type": "college", "id": "COLL0001"},
        ]
        if not any(s.get("type") == "department" for s in scope):
            scope.append({"type": "department", "id": dept_id})

        await db[COL_ROLE_ASSIGN].insert_one({"user_id": user_id, "role_id": role_doc["role_id"], "scope": scope})

        await db[COL_FACULTY].insert_one(
            {
                "faculty_id": faculty_id,
                "user_id": user_id,
                "email": email,
                "employment_type": employment_type,
                "department_id": dept_id,
                "fac_position": "Lecturer",
                "max_preps": 3,
                "certifications": _normalize_certifications(payload.get("certifications")),
                "hire_date": _normalize_hire_date(payload.get("hire_date")),
                "teaching_years": (
                    _teaching_years_from_hire_date(payload.get("hire_date"))
                    if payload.get("hire_date")
                    else _coerce_int(payload.get("teaching_years"))
                ),
            }
        )

        return {"ok": True, "user_id": user_id, "faculty_id": faculty_id}

    # ----- UPDATE -----
    if action == "update":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")
        fac = await db[COL_FACULTY].find_one({"faculty_id": facultyId})
        if not fac:
            raise HTTPException(status_code=404, detail="Faculty profile not found.")

        user_id = fac.get("user_id")
        user_update: Dict[str, Any] = {}
        if "first_name" in payload:
            user_update["first_name"] = str(payload["first_name"]).strip()
        if "last_name" in payload:
            user_update["last_name"] = str(payload["last_name"]).strip()

        if "email" in payload:
            email = str(payload["email"]).strip().lower()
            if email:
                exist = await db[COL_USERS].find_one({"email": email, "user_id": {"$ne": user_id}})
                if exist:
                    raise HTTPException(status_code=409, detail="Email already exists.")
                user_update["email"] = email

        if user_id and user_update:
            await db[COL_USERS].update_one({"user_id": user_id}, {"$set": user_update})

        fac_update: Dict[str, Any] = {}
        fac_unset: Dict[str, Any] = {}
        next_department_id: Optional[str] = None

        if "employment_type" in payload:
            et = str(payload["employment_type"]).strip().upper()
            if et in {"FT", "PT"}:
                fac_update["employment_type"] = et

        if "department" in payload:
            dname = str(payload["department"]).strip()
            if dname:
                dept_doc = await db[COL_DEPARTMENTS].find_one(
                    {"$or": [{"department_name": dname}, {"dept_name": dname}]},
                    {"_id": 0, "department_id": 1},
                )
                if dept_doc:
                    next_department_id = dept_doc["department_id"]
                    fac_update["department_id"] = next_department_id

        if "certifications" in payload:
            fac_update["certifications"] = _normalize_certifications(payload["certifications"])

        if "hire_date" in payload:
            if payload.get("hire_date"):
                norm_hd = _normalize_hire_date(payload.get("hire_date"))
                if norm_hd is not None:
                    fac_update["hire_date"] = norm_hd

                yrs = _teaching_years_from_hire_date(payload.get("hire_date"))
                if yrs is not None:
                    fac_update["teaching_years"] = yrs
            else:
                fac_unset["hire_date"] = ""
                fac_unset["teaching_years"] = ""
        elif "teaching_years" in payload:
            coerced = _coerce_int(payload["teaching_years"])
            if coerced is None:
                fac_unset["teaching_years"] = ""
            else:
                fac_update["teaching_years"] = coerced

        if "email" in payload:
            fac_update["email"] = str(payload["email"]).strip().lower()

        update_doc: Dict[str, Any] = {}
        if fac_update:
            update_doc["$set"] = fac_update
        if fac_unset:
            update_doc["$unset"] = fac_unset

        if update_doc:
            await db[COL_FACULTY].update_one({"faculty_id": facultyId}, update_doc)

        if next_department_id:
            await _sync_role_assignment_department_scope(user_id, next_department_id)

        return {"ok": True}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
