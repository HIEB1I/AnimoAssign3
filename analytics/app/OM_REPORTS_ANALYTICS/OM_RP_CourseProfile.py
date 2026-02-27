# analytics/app/OM_REPORTS_ANALYTICS/OM_RP_CourseProfile.py
from typing import Any, Dict, List, Optional
from collections import defaultdict
import math
import re

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..db_async import get_db

router = APIRouter()


def _fmt_ay(start: Optional[int]) -> str:
    if start is None:
        return "—"
    return f"{start}–{start + 1}"

def _fmt_term(n: Optional[int]) -> str:
    return f"Term {n}" if isinstance(n, int) else "—"

async def get_course_profile_for(
    query: str,
    anchor_term_id: Optional[str] = None,
    direction: str = "current",
) -> Dict[str, Any]:
    """
    Returns Course Profile payload used by Reports & Analytics.

    Key goals:
    - Never crash on mixed/dirty data (e.g., acad_year_start stored as str in some docs).
    - Avoid oversized aggregation outputs (do not $push huge arrays).
    - Prefer active (non-archived) assignment rows per section; fallback to archived when no active exists.
    """
    db = get_db()

    def _safe_int(x: Any) -> Optional[int]:
        if isinstance(x, int):
            return x
        if isinstance(x, float) and x.is_integer():
            return int(x)
        if isinstance(x, str):
            s = x.strip()
            if not s:
                return None
            try:
                return int(s)
            except Exception:
                return None
        return None

    q = (query or "").strip()
    if not q:
        return {"course_id": "", "title": "Not found"}

    # 1) Find course by id OR element of course_code[] (case-insensitive).
    # NOTE: We intentionally match an *element* of course_code[]; callers should pass either course_id
    # or a single code (not a joined string like "CODE1 / CODE2").
    course = await db.courses.find_one(
        {
            "$or": [
                {"course_id": {"$regex": f"^{re.escape(q)}$", "$options": "i"}},
                {"course_code": {"$elemMatch": {"$regex": f"^{re.escape(q)}$", "$options": "i"}}},
            ]
        }
    )
    if not course:
        return {"course_id": q, "title": "Not found"}

    course_id: str = course.get("course_id")
    course_code: List[str] = course.get("course_code") or []
    title: str = course.get("course_title") or course.get("title") or ""

    # 2) KACs that include this course (used for "Qualified KAC" + Preferences panel).
    kac_docs = await db.kacs.find({"course_list": course_id}, {"kac_id": 1}).to_list(None)
    kac_ids = [k.get("kac_id") for k in kac_docs if k.get("kac_id")]

    kac_qualified_ids: set = set()
    if kac_ids:
        kac_qualified_ids = {
            str(x)
            for x in await db.faculty_profiles.distinct(
                "faculty_id", {"qualified_kacs": {"$in": kac_ids}}
            )
            if x
        }

    # 3) Teaching history per faculty (distinct AY/Term occurrences).
    # Prefer active assignment rows per section; fallback to archived if no active exists for that section.
    pipeline_teach_hist = [
        {"$match": {"course_id": course_id}},
        {"$lookup": {
            "from": "terms",
            "localField": "term_id",
            "foreignField": "term_id",
            "as": "term",
        }},
        {"$unwind": {"path": "$term", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {
            "from": "faculty_assignments",
            "let": {"sid": "$section_id"},
            "pipeline": [
                {"$match": {"$expr": {"$eq": ["$section_id", "$$sid"]}}},
                {"$project": {"_id": 0, "faculty_id": 1, "is_archived": 1}},
            ],
            "as": "fa_all",
        }},
        {"$addFields": {
            "fa_active": {
                "$filter": {
                    "input": "$fa_all",
                    "as": "fa",
                    "cond": {"$ne": ["$$fa.is_archived", True]},
                }
            }
        }},
        {"$addFields": {
            "fa_use": {
                "$cond": [
                    {"$gt": [{"$size": "$fa_active"}, 0]},
                    "$fa_active",
                    "$fa_all",
                ]
            }
        }},
        {"$unwind": {"path": "$fa_use", "preserveNullAndEmptyArrays": False}},
        {"$project": {
            "_id": 0,
            "faculty_id": {"$toString": "$fa_use.faculty_id"},
            "acad_year_start": "$term.acad_year_start",
            "term_number": "$term.term_number",
        }},
        {"$group": {
            "_id": "$faculty_id",
            "terms": {"$addToSet": {"ay": "$acad_year_start", "term": "$term_number"}},
        }},
        {"$project": {"_id": 0, "faculty_id": "$_id", "terms": 1}},
    ]

    teach_hist_by_fid: Dict[str, Dict[str, Any]] = {}
    taught_ids: set = set()

    rows_th = await db.sections.aggregate(pipeline_teach_hist, allowDiskUse=True).to_list(None)
    for r in rows_th:
        fid = str(r.get("faculty_id") or "").strip()
        if not fid:
            continue

        terms_raw = r.get("terms") or []
        terms_clean: List[Dict[str, int]] = []
        for t in terms_raw:
            ay = _safe_int(t.get("ay"))
            tn = _safe_int(t.get("term"))
            if isinstance(ay, int) and isinstance(tn, int):
                terms_clean.append({"acad_year_start": ay, "term_number": tn})

        terms_clean.sort(key=lambda x: (x["acad_year_start"], x["term_number"]), reverse=True)

        teach_hist_by_fid[fid] = {"count": len(terms_clean), "terms": terms_clean}
        taught_ids.add(fid)

    # 4) Qualified faculty = taught OR KAC-qualified
    fac_ids = sorted(taught_ids | kac_qualified_ids)

    prof_by_fid: Dict[str, Dict[str, Any]] = {}
    user_by_id: Dict[str, Dict[str, Any]] = {}
    if fac_ids:
        fps = await db.faculty_profiles.find(
            {"faculty_id": {"$in": fac_ids}}, {"faculty_id": 1, "user_id": 1}
        ).to_list(None)
        prof_by_fid = {str(fp.get("faculty_id")): fp for fp in fps if fp.get("faculty_id")}

        user_ids = {str(fp.get("user_id")) for fp in fps if fp.get("user_id")} | set(fac_ids)
        users = await db.users.find(
            {"user_id": {"$in": list(user_ids)}},
            {"user_id": 1, "first_name": 1, "last_name": 1, "email": 1},
        ).to_list(None)
        user_by_id = {str(u.get("user_id")): u for u in users if u.get("user_id")}

    qualified: List[Dict[str, Any]] = []
    for fid in fac_ids:
        fp = prof_by_fid.get(fid, {})
        uid = str(fp.get("user_id") or fid)
        u = user_by_id.get(uid) or user_by_id.get(fid) or {}

        source_bits: List[str] = []
        if fid in taught_ids:
            source_bits.append("Teaching History")
        if fid in kac_qualified_ids:
            source_bits.append("Qualified KAC")

        out = {
            "faculty_id": fid,
            "first_name": u.get("first_name"),
            "last_name": u.get("last_name"),
            "email": u.get("email"),
            "source": " & ".join(source_bits) if source_bits else "—",
        }

        if fid in taught_ids:
            out["teaching_history"] = teach_hist_by_fid.get(fid, {"count": 0, "terms": []})

        qualified.append(out)

    # 5) Past instructors insight (COUNT DISTINCT SECTIONS per faculty).
    # IMPORTANT: do NOT push large arrays to avoid 16MB document limits.
    pipeline_past = [
        {"$match": {"course_id": course_id}},
        {"$lookup": {
            "from": "faculty_assignments",
            "let": {"sid": "$section_id"},
            "pipeline": [
                {"$match": {"$expr": {"$eq": ["$section_id", "$$sid"]}}},
                {"$project": {"_id": 0, "faculty_id": 1, "is_archived": 1}},
            ],
            "as": "fa_all",
        }},
        {"$addFields": {
            "fa_active": {
                "$filter": {
                    "input": "$fa_all",
                    "as": "fa",
                    "cond": {"$ne": ["$$fa.is_archived", True]},
                }
            }
        }},
        {"$addFields": {
            "fa_use": {
                "$cond": [
                    {"$gt": [{"$size": "$fa_active"}, 0]},
                    "$fa_active",
                    "$fa_all",
                ]
            }
        }},
        {"$unwind": {"path": "$fa_use", "preserveNullAndEmptyArrays": False}},
        {"$project": {"faculty_id": {"$toString": "$fa_use.faculty_id"}, "section_id": 1}},
        {"$group": {"_id": "$faculty_id", "sections": {"$addToSet": "$section_id"}}},
        {"$project": {"_id": 0, "faculty_id": "$_id", "count": {"$size": "$sections"}}},

        # names
        {"$lookup": {
            "from": "faculty_profiles",
            "let": {"fid": "$faculty_id"},
            "pipeline": [
                {"$match": {"$expr": {"$eq": [{"$toString": "$faculty_id"}, "$$fid"]}}},
                {"$project": {"_id": 0, "user_id": 1}},
            ],
            "as": "fp",
        }},
        {"$unwind": {"path": "$fp", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {
            "from": "users",
            "let": {"uid": "$fp.user_id", "fid": "$faculty_id"},
            "pipeline": [
                {"$match": {"$expr": {"$or": [
                    {"$eq": ["$user_id", "$$uid"]},
                    {"$eq": ["$user_id", "$$fid"]},
                ]}}},
                {"$project": {"_id": 0, "first_name": 1, "last_name": 1, "email": 1}},
            ],
            "as": "user",
        }},
        {"$unwind": {"path": "$user", "preserveNullAndEmptyArrays": True}},
        {"$project": {
            "faculty_id": 1,
            "count": 1,
            "first_name": "$user.first_name",
            "last_name": "$user.last_name",
            "email": "$user.email",
        }},
        {"$sort": {"count": -1, "last_name": 1, "first_name": 1}},
    ]

    past = await db.sections.aggregate(pipeline_past, allowDiskUse=True).to_list(None)
    top_3_instructors = past[:3]
    remaining_instructors_count = max(len(past) - len(top_3_instructors), 0)
    other_instructors = past[3:] if len(past) > 3 else []

    # 6) History metrics (course demand over time, unique instructors, most recent taught).
    pipeline_history = [
        {"$match": {"course_id": course_id}},
        {"$lookup": {
            "from": "terms",
            "localField": "term_id",
            "foreignField": "term_id",
            "as": "term",
        }},
        {"$unwind": {"path": "$term", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {
            "from": "faculty_assignments",
            "let": {"sid": "$section_id"},
            "pipeline": [
                {"$match": {"$expr": {"$eq": ["$section_id", "$$sid"]}}},
                {"$project": {"_id": 0, "faculty_id": 1, "is_archived": 1}},
            ],
            "as": "fa_all",
        }},
        {"$addFields": {
            "fa_active": {
                "$filter": {
                    "input": "$fa_all",
                    "as": "fa",
                    "cond": {"$ne": ["$$fa.is_archived", True]},
                }
            }
        }},
        {"$addFields": {
            "fa_use": {
                "$cond": [
                    {"$gt": [{"$size": "$fa_active"}, 0]},
                    "$fa_active",
                    "$fa_all",
                ]
            }
        }},
        {"$project": {
            "_id": 0,
            "section_id": 1,
            "acad_year_start": "$term.acad_year_start",
            "term_number": "$term.term_number",
            "faculty_ids": {
                "$map": {"input": "$fa_use", "as": "fa", "in": "$$fa.faculty_id"}
            },
        }},
    ]

    history_rows = await db.sections.aggregate(pipeline_history, allowDiskUse=True).to_list(None)

    unique_sections_for_count: set = set()
    unique_instructors: set = set()
    academic_years: set = set()
    ay_term_counts: Dict[int, Dict[int, int]] = defaultdict(lambda: defaultdict(int))

    most_recent: Optional[tuple] = None  # (ay, term)

    for entry in history_rows:
        sid = entry.get("section_id")
        if not sid or sid in unique_sections_for_count:
            continue
        unique_sections_for_count.add(sid)

        ay = _safe_int(entry.get("acad_year_start"))
        tn = _safe_int(entry.get("term_number"))

        if isinstance(ay, int):
            academic_years.add(ay)
            if isinstance(tn, int) and tn in (1, 2, 3):
                ay_term_counts[ay][tn] += 1

        # unique instructors for this section (active-first, fallback already applied)
        for fid in (entry.get("faculty_ids") or []):
            if fid:
                unique_instructors.add(str(fid))

        if isinstance(ay, int) and isinstance(tn, int):
            if most_recent is None or (ay, tn) > most_recent:
                most_recent = (ay, tn)

    total_sections = len(unique_sections_for_count)
    num_unique_instructors = len(unique_instructors)
    num_acad_years = len(academic_years)
    avg_teaching_frequency = (
        round(total_sections / num_acad_years, 2) if num_acad_years > 0 else 0.0
    )

    ay_demand_visual: List[Dict[str, Any]] = []
    for ay in sorted(ay_term_counts.keys()):
        ay_demand_visual.append({
            "ay": ay,
            "t1": int(ay_term_counts[ay].get(1, 0)),
            "t2": int(ay_term_counts[ay].get(2, 0)),
            "t3": int(ay_term_counts[ay].get(3, 0)),
        })

    most_recent_ay = most_recent[0] if most_recent else None
    most_recent_term = most_recent[1] if most_recent else None

    # 7) Term context + Preferences (same paging logic as other analytics reports)
    preferences: Any = "N/A"

    terms: List[Dict[str, Any]] = (
        await db.terms.find(
            {},
            {"term_id": 1, "term_number": 1, "acad_year_start": 1, "is_current": 1},
        )
        .sort([("acad_year_start", 1), ("term_number", 1), ("term_id", 1)])
        .to_list(None)
    )

    default_index = 0
    cur_idx = -1
    for i, t in enumerate(terms):
        if t.get("is_current"):
            cur_idx = i
            break
    if cur_idx >= 0:
        default_index = min(cur_idx + 1, len(terms) - 1) if terms else 0
    elif terms:
        default_index = len(terms) - 1

    idx = default_index
    if anchor_term_id:
        for i, t in enumerate(terms):
            if t.get("term_id") == anchor_term_id:
                idx = i
                break

    if direction == "next":
        idx = min(idx + 1, len(terms) - 1) if terms else 0
    elif direction == "prev":
        idx = max(idx - 1, 0) if terms else 0

    selected_term = terms[idx] if terms else None
    has_prev = bool(terms) and idx > 0
    has_next = bool(terms) and idx < (len(terms) - 1)

    # Preferences list for the selected term (only if the course is in some KAC list)
    prefs_list: List[Dict[str, Any]] = []
    active_term_display = None
    if selected_term:
        ay = _safe_int(selected_term.get("acad_year_start"))
        tn = _safe_int(selected_term.get("term_number"))
        if isinstance(ay, int) and isinstance(tn, int):
            active_term_display = f"AY {_fmt_ay(ay)} {_fmt_term(tn)}"
        elif isinstance(ay, int):
            active_term_display = f"AY {_fmt_ay(ay)}"
        elif isinstance(tn, int):
            active_term_display = _fmt_term(tn)

    if selected_term and kac_ids:
        pipeline_prefs = [
            {"$match": {
                "term_id": selected_term.get("term_id"),
                "preferred_kacs": {"$in": kac_ids},
            }},
            {"$lookup": {
                "from": "faculty_profiles",
                "localField": "faculty_id",
                "foreignField": "faculty_id",
                "as": "fp",
            }},
            {"$unwind": {"path": "$fp", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {
                "from": "users",
                "let": {"uid": "$fp.user_id", "fid": "$faculty_id"},
                "pipeline": [
                    {"$match": {"$expr": {"$or": [
                        {"$eq": ["$user_id", "$$uid"]},
                        {"$eq": ["$user_id", "$$fid"]},
                    ]}}},
                    {"$project": {"_id": 0, "first_name": 1, "last_name": 1, "email": 1}},
                ],
                "as": "user",
            }},
            {"$unwind": {"path": "$user", "preserveNullAndEmptyArrays": True}},
            {"$group": {
                "_id": "$faculty_id",
                "faculty_id": {"$first": "$faculty_id"},
                "first_name": {"$first": "$user.first_name"},
                "last_name": {"$first": "$user.last_name"},
                "email": {"$first": "$user.email"},
            }},
            {"$project": {"_id": 0, "faculty_id": 1, "first_name": 1, "last_name": 1, "email": 1}},
            {"$sort": {"last_name": 1, "first_name": 1}},
        ]

        async for row in db.faculty_preferences.aggregate(pipeline_prefs, allowDiskUse=True):
            prefs_list.append({
                "faculty_id": row.get("faculty_id"),
                "first_name": row.get("first_name"),
                "last_name": row.get("last_name"),
                "email": row.get("email"),
            })

        if prefs_list:
            preferences = prefs_list
        else:
            preferences = f"No faculty preference submissions yet for {active_term_display or '—'}."
    elif selected_term and not kac_ids:
        preferences = f"No matching KAC lists this course for {active_term_display or '—'}."
    else:
        preferences = "No term found."

    return {
        "course_id": course_id,
        "course_code": course_code,
        "title": title,
        "qualified_faculty": qualified,
        "past_instructors_top3": top_3_instructors,
        "past_instructors_remaining_count": remaining_instructors_count,
        "past_instructors_others": other_instructors,
        "term": {
            "term_id": (selected_term or {}).get("term_id"),
            "acad_year_start": (selected_term or {}).get("acad_year_start"),
            "term_number": (selected_term or {}).get("term_number"),
        },
        "has_prev": has_prev,
        "has_next": has_next,
        "terms": [
            {
                "term_id": t.get("term_id"),
                "acad_year_start": t.get("acad_year_start"),
                "term_number": t.get("term_number"),
                "is_current": t.get("is_current"),
            }
            for t in terms
        ],
        "current_index": idx,
        "active_term": {
            "term_id": (selected_term or {}).get("term_id"),
            "acad_year_start": (selected_term or {}).get("acad_year_start"),
            "term_number": (selected_term or {}).get("term_number"),
        },
        "history_metrics": {
            "total_sections": total_sections,
            "unique_instructors": num_unique_instructors,
            "avg_teaching_frequency": avg_teaching_frequency,
            "most_recent_taught": {
                "acad_year_start": most_recent_ay,
                "term_number": most_recent_term,
            },
            "ay_demand_visual": ay_demand_visual,
        },
        "preferences": preferences,
    }

@router.get("/analytics/course-profile-for")
async def course_profile_for(
    query: str = Query(..., description="course_id or course_code"),
    anchor_term_id: Optional[str] = Query(None, description="Optional anchor term_id for paging"),
    direction: str = Query("current", description="current | next | prev"),
):
    data = await get_course_profile_for(query, anchor_term_id=anchor_term_id, direction=direction)
    return JSONResponse(content=data)