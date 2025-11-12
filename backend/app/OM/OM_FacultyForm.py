# backend/app/OM/OM_FacultyForm.py
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query
from ..main import db
from datetime import datetime, timezone, timedelta  # <-- add

router = APIRouter(prefix="/om", tags=["om"])

# ---- Collections (existing) ----
COL_USERS = "users"
COL_FACULTY = "faculty_profiles"
COL_DEPARTMENTS = "departments"
COL_TERMS = "terms"
COL_PREFS = "faculty_preferences"  # existing preferences table

# ---- Helpers (same style as Faculty Management) ----
def _dept_name_expr() -> Dict[str, Any]:
    return {"$ifNull": ["$dept.department_name", "$dept.dept_name"]}

def _full_name_expr() -> Dict[str, Any]:
    """Prefer joined users.{first,last}_name, fallback to faculty_profiles fields."""
    last = {"$ifNull": ["$u.last_name", "$last_name"]}
    first = {"$ifNull": ["$u.first_name", "$first_name"]}
    # Add comma only if both parts exist
    return {
        "$trim": {
            "input": {
                "$concat": [
                    {"$ifNull": [last, ""]},
                    {
                        "$cond": [
                            {"$and": [
                                {"$ne": [last, None]},
                                {"$ne": [first, None]},
                                {"$ne": [last, ""]},
                                {"$ne": [first, ""]},
                            ]},
                            ", ",
                            ""
                        ]
                    },
                    {"$ifNull": [first, ""]},
                ]
            }
        }
    }

def _faculty_type_display() -> Dict[str, Any]:
    """Map employment_type codes to human labels."""
    return {
        "$switch": {
            "branches": [
                {"case": {"$eq": ["$employment_type", "FT"]}, "then": "Full-Time"},
                {"case": {"$eq": ["$employment_type", "PT"]}, "then": "Part-Time"},
            ],
            "default": {"$ifNull": ["$employment_type", ""]},
        }
    }


# (new) parse date like in FACULTY_Preferences backend
def _parse_date_any(dt):
    if isinstance(dt, datetime):
        return dt
    if not dt:
        return None
    try:
        return datetime.fromisoformat(str(dt).replace("Z", "+00:00"))
    except Exception:
        return None

# (new) compute open/deadline like FACULTY_Preferences
def _prefs_window_from_term(term: Dict[str, Any]) -> tuple[datetime, datetime]:
    start = _parse_date_any(term.get("classes_start_date")) or _parse_date_any(term.get("start_date")) or datetime.now(timezone.utc)
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    open_dt = start + timedelta(weeks=6)   # Week 7
    close_dt = open_dt + timedelta(days=30)
    return open_dt, close_dt

async def _active_term():
    # (unchanged) but now also grab start/classes_start for window calc
    t = await db[COL_TERMS].find_one(
        {"$or": [{"status": "active"}, {"is_current": True}]},
        {
            "_id": 0,
            "term_id": 1,
            "acad_year_start": 1,
            "term_number": 1,
            "submission_deadline": 1,
            "start_date": 1,             # <-- added
            "classes_start_date": 1,     # <-- added
        },
    )
    if t:
        return t
    last = await db[COL_TERMS].find(
        {},
        {
            "_id": 0,
            "term_id": 1,
            "acad_year_start": 1,
            "term_number": 1,
            "submission_deadline": 1,
            "start_date": 1,
            "classes_start_date": 1,
        },
    ).sort([("acad_year_start", -1), ("term_number", -1)]).limit(1).to_list(1)
    return last[0] if last else {}

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

        # NEW: compute open/deadline like FACULTY_Preferences backend
        open_dt, close_dt = _prefs_window_from_term(active or {})
        prefs_window = {
            "openISO": open_dt.isoformat(),
            "deadlineISO": close_dt.isoformat(),
            "term_id": active.get("term_id"),
        }

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
            "prefs_window": prefs_window,  # <-- added
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
                # Status rule: default "Not Submitted", flip to "Submitted" if is_finished == true
                "submission_status": {
                    "$cond": [{"$eq": ["$pref.is_finished", True]}, "Submitted", "Not Submitted"]
                },
                # Date rule: only use submitted_at; otherwise null (frontend shows N/A)
                "submission_date": {"$ifNull": ["$pref.submitted_at", None]},
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
                    # Project only existing fields from your screenshot
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

            {"$addFields": {
                "teaching": {
                    "preferred_units": {"$ifNull": ["$pref.preferred_units", None]},
                    "deloading": {"$ifNull": ["$pref.deloading_data", None]},
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
                    "date": {"$ifNull": ["$pref.submitted_at", None]},
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

        doc = [d async for d in db[COL_FACULTY].aggregate(pipeline)]
        return {"ok": bool(doc), "preference": (doc[0] if doc else {})}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
