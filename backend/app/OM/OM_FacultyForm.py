# backend/app/OM/OM_FacultyForm.py
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query
import re

from ..main import db

router = APIRouter(prefix="/om", tags=["om"])

# ---- Collections (existing) ----
COL_USERS = "users"
COL_FACULTY = "faculty_profiles"
COL_DEPARTMENTS = "departments"
COL_TERMS = "terms"
COL_PREFS = "faculty_preferences"
COL_CAMPUSES = "campuses"
COL_KACS = "kacs"

# ---- Helpers (same style as Faculty Management) ----
def _dept_name_expr():
    return {"$ifNull": ["$dept.department_name", "$dept.dept_name"]}

def _full_name_expr():
    # Keep DB order (first then last), your UI prints it as-is
    return {
        "$trim": {
            "input": {"$concat": [
                {"$ifNull": ["$u.first_name", ""]}, " ",
                {"$ifNull": ["$u.last_name",  ""]},
            ]}
        }
    }

def _faculty_type_display():
    return {
        "$switch": {
            "branches": [
                {"case": {"$eq": ["$employment_type", "FT"]}, "then": "Full-Time"},
                {"case": {"$eq": ["$employment_type", "PT"]}, "then": "Part-Time"},
            ],
            "default": {"$ifNull": ["$employment_type", ""]},
        }
    }

async def _active_term() -> Dict[str, Any]:
    t = await db[COL_TERMS].find_one(
        {"$or": [{"status": "active"}, {"is_current": True}]},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1, "submission_deadline": 1},
    )
    if t:
        return t
    last = await db[COL_TERMS].find(
        {}, {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1, "submission_deadline": 1}
    ).sort([("acad_year_start", -1), ("term_number", -1)]).limit(1).to_list(1)
    return last[0] if last else {}

# ---------- Pretty-format helpers (OM-side only) ----------
DAY_LETTER_TO_NAME = {"M": "Monday", "T": "Tuesday", "W": "Wednesday", "H": "Thursday", "F": "Friday", "S": "Saturday"}
DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

def _expand_day_groups(groups: Optional[List[str]]) -> List[str]:
    """
    Faculty submit stores compressed groups like ["MW","H"].
    OM should show full names as a sorted unique list.
    """
    if not groups:
        return []
    expanded: List[str] = []
    for g in groups:
        for ch in str(g):
            nm = DAY_LETTER_TO_NAME.get(ch)
            if nm:
                expanded.append(nm)
    # unique in weekday order
    out: List[str] = []
    for d in DAY_ORDER:
        if d in expanded and d not in out:
            out.append(d)
    return out

def _fmt_time_range(s: str) -> str:
    """
    0915-1045  ->  09:15 - 10:45
    """
    m = re.match(r"^(\d{3,4})-(\d{3,4})$", s or "")
    if not m:
        return s
    def hhmm(x: str) -> str:
        x = x.zfill(4)
        return f"{x[:2]}:{x[2:]}"
    return f"{hhmm(m.group(1))} - {hhmm(m.group(2))}"

async def _mode_label(mode: Any) -> str:
    """
    Convert stored mode object into a nice label for OM:
      {"mode":"FOL", "campus_id":[...]} -> "Fully Online"
      {"mode":"HYB", "campus_id":["CMPS0001"]} -> "Hybrid — Manila"
      {"mode":"HYB", "campus_id":["CMPS0002"]} -> "Hybrid — Laguna"
      both -> "Hybrid — Manila, Laguna"
    """
    if not isinstance(mode, dict):
        # already a string label or empty
        return str(mode) if mode else "—"

    code = str(mode.get("mode") or "").upper()
    campus_ids = mode.get("campus_id") or []
    if code == "FOL":
        return "Fully Online"

    names: List[str] = []
    if campus_ids:
        cursor = db[COL_CAMPUSES].find(
            {"campus_id": {"$in": campus_ids}},
            {"_id": 0, "campus_id": 1, "campus_name": 1},
        )
        found = {c["campus_id"]: c.get("campus_name") for c in await cursor.to_list(length=10)}
        # preserve submitted order
        for cid in campus_ids:
            nm = found.get(cid)
            if nm:
                names.append(nm)

    if code == "HYB":
        label = "Hybrid"
        if names:
            label += " — " + ", ".join(names)
        return label

    return code or "—"

async def _kac_strings(raw: Any) -> List[str]:
    """
    Convert preferred_kacs into a string array (names/codes) for OM display.
    Accepts: list[str] | list[object] | None
    """
    if not raw:
        return []
    out: List[str] = []
    string_ids: List[str] = []
    for item in raw:
        if isinstance(item, dict):
            out.append(item.get("kac_name") or item.get("kac_code") or item.get("kac_id") or "")
        else:
            s = str(item).strip()
            if s:
                string_ids.append(s)

    if string_ids:
        cur = db[COL_KACS].find(
            {"kac_id": {"$in": string_ids}},
            {"_id": 0, "kac_id": 1, "kac_name": 1, "kac_code": 1},
        )
        found = {k["kac_id"]: k for k in await cur.to_list(length=200)}
        for sid in string_ids:
            k = found.get(sid)
            if not k:
                out.append(sid)
            else:
                out.append(k.get("kac_name") or k.get("kac_code") or sid)

    # clean empties
    return [x for x in out if x]

def _deload_strings(raw: Any) -> List[str]:
    """
    Convert [{deloading_type, units}] -> ["Administrative — 3 units", ...]
    """
    if not isinstance(raw, list):
        return []
    out: List[str] = []
    for r in raw:
        if not isinstance(r, dict):
            continue
        t = (r.get("deloading_type") or "").strip()
        u = r.get("units", 0)
        try:
            u = float(u)
        except Exception:
            u = 0
        if t:
            out.append(f"{t} — {u:g} units")
    return out

@router.post("/facultyforms")
async def facultyforms_handler(
    action: str = Query("list", description="options | list | view"),
    department: Optional[str] = Query(None),
    facultyType: Optional[str] = Query(None, description="Full-Time | Part-Time | All Faculty Type"),
    status: Optional[str] = Query(None, description="Submitted | Not Submitted | All Status"),
    search: Optional[str] = Query(None),
    facultyId: Optional[str] = Query(None),
    termId: Optional[str] = Query(None),
):
    # ----- OPTIONS -----
    if action == "options":
        depts = [d async for d in db[COL_DEPARTMENTS].find({}, {"_id": 0, "department_name": 1, "dept_name": 1})]
        department_options = sorted({
            (d.get("department_name") or d.get("dept_name") or "").strip()
            for d in depts if (d.get("department_name") or d.get("dept_name"))
        })

        codes = await db[COL_FACULTY].distinct("employment_type")
        type_map = {"FT": "Full-Time", "PT": "Part-Time"}
        faculty_types = sorted({type_map.get(c, c) for c in codes if c})

        active = await _active_term()
        ay = active.get("acad_year_start")
        tn = active.get("term_number")
        label = f"Term {tn} AY {ay}–{(ay + 1) if ay else ''}" if (ay and tn) else None

        return {
            "ok": True,
            "departments": department_options,
            "facultyTypes": faculty_types,
            "activeTerm": {
                "term_id": active.get("term_id"),
                "acad_year_start": ay,
                "term_number": tn,
                "label": label,
                "submission_deadline": active.get("submission_deadline"),
            },
        }

    # ----- Resolve term (no parsing of termId strings) -----
    term_doc = None
    if termId:
        term_doc = await db[COL_TERMS].find_one(
            {"term_id": termId},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1}
        )
    if not term_doc:
        term_doc = await _active_term()

    termId = term_doc.get("term_id")
    ay_from_term = term_doc.get("acad_year_start")

    # ----- LIST -----
    if action == "list":
        early_match: Dict[str, Any] = {}
        if facultyType and facultyType.strip().lower() != "all faculty type":
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
                        {"$and": [{"$ne": ["$$uid", None]}, {"$eq": ["$user_id", "$$uid"]}]},
                        {"$and": [{"$ne": ["$$femail", None]}, {"$eq": ["$email", "$$femail"]}]},
                    ]}}},
                    {"$project": {"_id": 0, "first_name": 1, "last_name": 1, "email": 1}}
                ],
                "as": "u"
            }},
            {"$unwind": {"path": "$u", "preserveNullAndEmptyArrays": True}},

            # Pull latest preference for this faculty in this term (or same AY)
            {"$lookup": {
                "from": COL_PREFS,
                "let": {"fid": "$faculty_id", "termId": termId, "ay": ay_from_term},
                "pipeline": [
                    {"$match": {"$expr": {"$and": [
                        {"$eq": ["$faculty_id", "$$fid"]},
                        {"$or": [
                            {"$eq": ["$term_id", "$$termId"]},
                            {"$and": [
                                {"$ne": ["$$ay", None]},
                                {"$eq": ["$acad_year_start", "$$ay"]}
                            ]}
                        ]}
                    ]}}},
                    {"$sort": {"submitted_at": -1, "updated_at": -1, "created_at": -1}},
                    {"$limit": 1},
                    {"$project": {
                        "_id": 0,
                        "is_finished": 1,
                        "submitted_at": 1
                    }}
                ],
                "as": "pref"
            }},
            {"$unwind": {"path": "$pref", "preserveNullAndEmptyArrays": True}},

            {"$addFields": {
                "department_display": _dept_name_expr(),
                "name": _full_name_expr(),
                "email_display": {"$ifNull": ["$u.email", "$email"]},
                "type_display": _faculty_type_display(),
                # Status: only Submitted when is_finished == true
                "submission_status": {
                    "$cond": [{"$eq": ["$pref.is_finished", True]}, "Submitted", "Not Submitted"]
                },
                # Date: show only when submitted (drafts -> N/A)
                "submission_date": {
                    "$cond": [
                        {"$eq": ["$pref.is_finished", True]},
                        "$pref.submitted_at",
                        None
                    ]
                },
            }},

            {"$match": {"$expr": {"$or": [
                {"$eq": [dept_filter, ""]},
                {"$eq": ["$department_display", dept_filter]}
            ]}}},
        ]

        if status and status.strip().lower() != "all status":
            pipeline.append({"$match": {"submission_status": status.strip()}})

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
                "email": "$email_display",
                "department": "$department_display",
                "type": "$type_display",
                "submission_date": 1,
                "status": "$submission_status",
            }},
            {"$sort": {"name": 1}}
        ])

        rows = [r async for r in db[COL_FACULTY].aggregate(pipeline)]
        return {"ok": True, "rows": rows}

    # ----- VIEW -----
    if action == "view":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")

        pipeline: List[Dict[str, Any]] = [
            {"$match": {"faculty_id": facultyId}},
            {"$lookup": {
                "from": COL_USERS,
                "let": {"uid": "$user_id", "femail": "$email"},
                "pipeline": [
                    {"$match": {"$expr": {"$or": [
                        {"$and": [{"$ne": ["$$uid", None]}, {"$eq": ["$user_id", "$$uid"]}]},
                        {"$and": [{"$ne": ["$$femail", None]}, {"$eq": ["$email", "$$femail"]}]},
                    ]}}},
                    {"$project": {"_id": 0, "first_name": 1, "last_name": 1, "email": 1}}
                ],
                "as": "u"
            }},
            {"$unwind": {"path": "$u", "preserveNullAndEmptyArrays": True}},
            {"$addFields": {"name": _full_name_expr(), "email_display": {"$ifNull": ["$u.email", "$email"]}}},

            {"$lookup": {
                "from": COL_PREFS,
                "let": {"fid": "$faculty_id", "termId": termId, "ay": ay_from_term},
                "pipeline": [
                    {"$match": {"$expr": {"$and": [
                        {"$eq": ["$faculty_id", "$$fid"]},
                        {"$or": [
                            {"$eq": ["$term_id", "$$termId"]},
                            {"$and": [
                                {"$ne": ["$$ay", None]},
                                {"$eq": ["$acad_year_start", "$$ay"]}
                            ]}
                        ]}
                    ]}}},
                    {"$sort": {"submitted_at": -1, "updated_at": -1, "created_at": -1}},
                    {"$limit": 1},
                    {"$project": {
                        "_id": 0,
                        "preferred_units": 1,
                        "preferred_times": 1,
                        "availability_days": 1,
                        "preferred_kacs": 1,
                        "mode": 1,
                        "deloading_data": 1,
                        "notes": 1,
                        "is_finished": 1,
                        "submitted_at": 1
                    }}
                ],
                "as": "pref"
            }},
            {"$unwind": {"path": "$pref", "preserveNullAndEmptyArrays": True}},

            # Build skeleton the UI expects; we will pretty-format in Python after aggregation
            {"$addFields": {
                "teaching": {
                    "preferred_units": {"$ifNull": ["$pref.preferred_units", None]},
                    "deloading": {"$ifNull": ["$pref.deloading_data", []]},
                },
                "location_mode": {
                    "mode": {"$ifNull": ["$pref.mode", None]},
                },
                "schedule": {
                    "days": {"$ifNull": ["$pref.availability_days", []]},
                    "times": {"$ifNull": ["$pref.preferred_times", []]},
                },
                "specialization": {
                    "courses": {"$ifNull": ["$pref.preferred_kacs", []]},
                },
                "submission": {
                    "status": {"$cond": [{"$eq": ["$pref.is_finished", True]}, "Submitted", "Not Submitted"]},
                    "date": {
                        "$cond": [
                            {"$eq": ["$pref.is_finished", True]},
                            {"$ifNull": ["$pref.submitted_at", None]},
                            None
                        ]
                    },
                    "notes": {"$ifNull": ["$pref.notes", None]},
                }
            }},
            {"$project": {
                "_id": 0,
                "faculty_id": 1,
                "name": 1,
                "email": "$email_display",
                "teaching": 1,
                "location_mode": 1,
                "schedule": 1,
                "specialization": 1,
                "submission": 1
            }},
            {"$limit": 1}
        ]

        docs = [d async for d in db[COL_FACULTY].aggregate(pipeline)]
        if not docs:
            return {"ok": False, "preference": {}}

        out = docs[0]

        # --- Pretty-format to MATCH what faculty submitted/see ---
        # Days: expand ["MW","H"] -> ["Monday","Wednesday","Thursday"]
        out["schedule"]["days"] = _expand_day_groups(out.get("schedule", {}).get("days"))

        # Time slots: "0915-1045" -> "09:15 - 10:45"
        raw_times = out.get("schedule", {}).get("times") or []
        out["schedule"]["times"] = [_fmt_time_range(str(t)) for t in raw_times]

        # Deloading: objects -> ["Administrative — 3 units", ...]
        out["teaching"]["deloading"] = _deload_strings(out.get("teaching", {}).get("deloading"))

        # Mode: object -> readable string label
        out["location_mode"]["mode"] = await _mode_label(out.get("location_mode", {}).get("mode"))

        # KACs: normalize to names/codes (string list)
        out["specialization"]["courses"] = await _kac_strings(out.get("specialization", {}).get("courses"))

        return {"ok": True, "preference": out}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
