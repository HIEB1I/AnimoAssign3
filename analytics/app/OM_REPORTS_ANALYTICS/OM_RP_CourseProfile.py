# analytics/app/OM_REPORTS_ANALYTICS/OM_RP_CourseProfile.py
from typing import Any, Dict, List, Optional
from collections import defaultdict
import math

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
    Returns Course Profile payload, including new descriptive analytics metrics.
    """
    db = get_db()
    q = (query or "").strip()
    if not q:
        return {"course_id": "", "title": "Not found"}

    # 1) find course by id OR element of course_code[] (case-insensitive)
    course = await db.courses.find_one({
        "$or": [
            {"course_id":   {"$regex": f"^{q}$", "$options": "i"}},
            {"course_code": {"$elemMatch": {"$regex": f"^{q}$", "$options": "i"}}},
        ]
    })
    if not course:
        return {"course_id": q, "title": "Not found"}

    course_id   = course.get("course_id")
    course_code = course.get("course_code") or []
    title       = course.get("course_title") or course.get("title") or ""

    # KACs that include this course
    kac_docs = await db.kacs.find(
        {"course_list": course_id},
        {"kac_id": 1, "course_list": 1}
    ).to_list(None)

    kac_ids = [k["kac_id"] for k in kac_docs]

    # -------- Qualified faculty (union of: taught this course ∪ qualified via KAC) --------
    qualified: List[Dict[str, Any]] = []
    # ... (Keep existing qualified faculty logic) ...
    if kac_ids:
        # A) taught THIS course
        sec_ids = await db.sections.distinct("section_id", {"course_id": course_id})
        taught_ids = set()
        if sec_ids:
            taught_ids = set(await db.faculty_assignments.distinct(
                "faculty_id", {"section_id": {"$in": sec_ids}}
            ))

        # B) KAC-qualified
        kac_qualified_ids = set(await db.faculty_profiles.distinct(
            "faculty_id", {"qualified_kacs": {"$in": kac_ids}}
        ))

        fac_ids = sorted(taught_ids | kac_qualified_ids)
        if fac_ids:
            fps = await db.faculty_profiles.find(
                {"faculty_id": {"$in": fac_ids}}, {"faculty_id": 1, "user_id": 1}
            ).to_list(None)
            prof_by_fid = {fp["faculty_id"]: fp for fp in fps}

            # Gather all relevant user_ids for name lookup
            user_ids = {fp.get("user_id") for fp in fps if fp.get("user_id")} | set(fac_ids)
            users = await db.users.find(
                {"user_id": {"$in": list(user_ids)}},
                {"user_id": 1, "first_name": 1, "last_name": 1, "email": 1}
            ).to_list(None)
            # Combine lookups into a single map based on uid or fid
            user_by_id = {u["user_id"]: u for u in users}

            for fid in fac_ids:
                # Prioritize user_id from faculty_profiles if available, otherwise use faculty_id
                uid = (prof_by_fid.get(fid) or {}).get("user_id") or fid
                u = user_by_id.get(uid, user_by_id.get(fid, {})) # check both uid and fid
                
                source_bits = []
                if fid in kac_qualified_ids:
                    source_bits.append("Qualified KAC")
                if fid in taught_ids:
                    source_bits.append("Teaching History")

                qualified.append({
                    "faculty_id": fid,
                    "first_name": u.get("first_name"),
                    "last_name":  u.get("last_name"),
                    "email":      u.get("email"),
                    "source":     " & ".join(source_bits) if source_bits else "—",
                })
    # -------- End of Qualified faculty --------

    # -------- Past instructors (aggregated) AND NEW METRICS CALCULATION --------
    past: List[Dict[str, Any]] = []
    
    # Aggregation for past instructors and section history
    pipeline_past = [
        {"$match": {"course_id": course_id}},
        {"$lookup": {
            "from": "faculty_assignments",
            "localField": "section_id",
            "foreignField": "section_id",
            "as": "fa"
        }},
        {"$unwind": "$fa"},
        {"$lookup": {
            "from": "terms",
            "localField": "term_id",
            "foreignField": "term_id",
            "as": "term"
        }},
        {"$unwind": {"path": "$term", "preserveNullAndEmptyArrays": True}},
        {"$project": {
            "_id": 0,
            "faculty_id": "$fa.faculty_id",
            "section_id": 1,
            "section_code": 1,
            "term_id": 1,
            "acad_year_start": "$term.acad_year_start",
            "term_number": "$term.term_number",
        }},
        {"$group": {
            "_id": "$faculty_id",
            "sections": {"$push": {
                "course_code": course_code,
                "section_id": "$section_id",
                "section_code": "$section_code",
                "term_id": "$term_id",
                "acad_year_start": "$acad_year_start",
                "term_number": "$term_number",
            }},
            "count": {"$sum": 1}
        }},
        # Lookup user info
        {"$lookup": {
            "from": "faculty_profiles",
            "localField": "_id",
            "foreignField": "faculty_id",
            "as": "fp"
        }},
        {"$unwind": {"path": "$fp", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {
            "from": "users",
            "let": { "uid": "$fp.user_id", "fid": "$_id" },
            "pipeline": [
                { "$match": {
                    "$expr": { "$or": [
                        { "$eq": ["$user_id", "$$uid"] },
                        { "$eq": ["$user_id", "$$fid"] }
                    ]}
                }},
                { "$project": { "first_name": 1, "last_name": 1, "email": 1 } }
            ],
            "as": "user"
        }},
        {"$unwind": { "path": "$user", "preserveNullAndEmptyArrays": True }},
        {"$project": {
            "_id": 0,
            "faculty_id": { "$toString": "$_id" },
            "first_name": "$user.first_name",
            "last_name":  "$user.last_name",
            "email":      "$user.email",
            "count": 1,
            "sections": 1
        }},
        {"$sort": { "count": -1, "last_name": 1, "first_name": 1 }},
    ]

    # Aggregate to get all past instructor data
    async for row in db.sections.aggregate(pipeline_past, allowDiskUse=True):
        past.append({
            "faculty_id": row["faculty_id"],
            "first_name": row.get("first_name"),
            "last_name":  row.get("last_name"),
            "email":      row.get("email"),
            "count":      row.get("count", 0),
            # Only store section counts, not the full list of sections, for the main instructor list
            # We'll re-run a simpler aggregation for the detailed metrics
            "sections":   row.get("sections", [])
        })

    # NEW METRICS CALCULATION (Separate, simpler aggregation for course history)
    pipeline_history = [
        {"$match": {"course_id": course_id}},
        {"$lookup": {
            "from": "terms",
            "localField": "term_id",
            "foreignField": "term_id",
            "as": "term"
        }},
        {"$unwind": {"path": "$term", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {
            "from": "faculty_assignments",
            "localField": "section_id",
            "foreignField": "section_id",
            "as": "fa"
        }},
        {"$unwind": {"path": "$fa", "preserveNullAndEmptyArrays": True}},
        {"$project": {
            "_id": 0,
            "section_id": 1,
            "acad_year_start": "$term.acad_year_start",
            "term_number": "$term.term_number",
            "faculty_id": "$fa.faculty_id",
        }}
    ]

    history_data = await db.sections.aggregate(pipeline_history, allowDiskUse=True).to_list(None)

    # Calculate metrics from history_data
    # FIX: Initialize the set here
    unique_sections_for_count: set = set()
    total_sections: int = 0
    unique_instructors: set = set()
    academic_years: set = set()
    ay_section_counts: Dict[int, int] = defaultdict(int)
    most_recent_ay: Optional[int] = None
    most_recent_term: Optional[int] = None

    for entry in history_data:
        # A section only counts once, even if it had multiple instructors
        if entry.get("section_id"):
             # Ensure we count each section only once for the total and AY counts
            if entry.get("section_id") not in unique_sections_for_count:
                # total_sections += 1 # Not needed if we use len() later
                unique_sections_for_count.add(entry.get("section_id"))
                
                ay = entry.get("acad_year_start")
                if ay:
                    academic_years.add(ay)
                    ay_section_counts[ay] += 1
        
            # Track unique instructors
            fid = entry.get("faculty_id")
            if fid:
                unique_instructors.add(fid)

        # Track Most Recent Term Taught
        ay = entry.get("acad_year_start")
        term = entry.get("term_number")
        
        if ay is not None and term is not None:
            if most_recent_ay is None or ay > most_recent_ay:
                most_recent_ay = ay
                most_recent_term = term
            elif ay == most_recent_ay and (most_recent_term is None or term > most_recent_term):
                most_recent_term = term
                
    # New Metric: Total Sections Taught
    # FIX: Use the length of the set for the count
    total_sections = len(unique_sections_for_count)
    
    # New Metric: Number of Unique Instructors
    num_unique_instructors = len(unique_instructors)
    
    # New Metric: Total Academic Years covered
    num_acad_years = len(academic_years)
    
    # New Metric: Average Teaching Frequency
    avg_teaching_frequency = round(total_sections / num_acad_years, 2) if num_acad_years > 0 else 0.0

    # New Metric: Top 3 Past Instructors
    # The 'past' list is already sorted by count descending
    top_3_instructors = past[:3]
    remaining_instructors_count = len(past) - len(top_3_instructors)

    # Other instructors beyond top 3 (for expandable UI)
    other_instructors = past[3:] if len(past) > 3 else []

    # Format AY section counts for the Demand Visual (Frontend)
    ay_demand_visual = [
        {"ay": ay, "sections": count} 
        for ay, count in sorted(ay_section_counts.items())
    ]
    
    # -------- Term context + Preferences --------
    # This report follows the same term paging logic used in Deloading Utilization.
    # The default view is the *planning* term = next term after the DB's is_current.
    preferences: Any = "N/A"

    terms: List[Dict[str, Any]] = await db.terms.find(
        {},
        {"term_id": 1, "term_number": 1, "acad_year_start": 1, "is_current": 1},
    ).sort([("acad_year_start", 1), ("term_number", 1), ("term_id", 1)]).to_list(None)

    # Determine default index (planning term if possible)
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

    # Anchor term selection (if provided)
    idx = default_index
    if anchor_term_id:
        for i, t in enumerate(terms):
            if t.get("term_id") == anchor_term_id:
                idx = i
                break

    # Apply paging direction relative to the anchor/default
    if direction == "next":
        idx = min(idx + 1, len(terms) - 1) if terms else 0
    elif direction == "prev":
        idx = max(idx - 1, 0) if terms else 0
    else:
        # "current" (or unknown) -> keep idx
        pass

    selected_term = terms[idx] if terms else None
    has_prev = bool(terms) and idx > 0
    has_next = bool(terms) and idx < (len(terms) - 1)

    prefs_list: List[Dict[str, Any]] = []

    active_term_display = None
    if selected_term:
        ay = selected_term.get("acad_year_start")
        tn = selected_term.get("term_number")
        if isinstance(ay, int) and isinstance(tn, int):
            active_term_display = f"AY {_fmt_ay(ay)} {_fmt_term(tn)}"
        elif isinstance(ay, int):
            active_term_display = f"AY {_fmt_ay(ay)}"
        elif isinstance(tn, int):
            active_term_display = _fmt_term(tn)

    if selected_term and kac_ids:
        # ... (Keep the rest of the preferences pipeline) ...
        pipeline_prefs = [
            {"$match": {
                "term_id": selected_term["term_id"],
                "preferred_kacs": {"$in": kac_ids}
            }},
            {"$lookup": {
                "from": "faculty_profiles",
                "localField": "faculty_id",
                "foreignField": "faculty_id",
                "as": "fp"
            }},
            {"$unwind": {"path": "$fp", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {
                "from": "users",
                "let": {"uid": "$fp.user_id", "fid": "$faculty_id"},
                "pipeline": [
                    {"$match": {"$expr": {"$or": [
                        {"$eq": ["$user_id", "$$uid"]},
                        {"$eq": ["$user_id", "$$fid"]}
                    ]}}},
                    {"$project": {"first_name": 1, "last_name": 1, "email": 1}}
                ],
                "as": "user"
            }},
            {"$unwind": {"path": "$user", "preserveNullAndEmptyArrays": True}},
            {"$project": {
                "_id": 0,
                "faculty_id": 1,
                "first_name": "$user.first_name",
                "last_name":  "$user.last_name",
                "email":      "$user.email",
            }},
            {"$group": {
                "_id": "$faculty_id",
                "faculty_id": {"$first": "$faculty_id"},
                "first_name": {"$first": "$first_name"},
                "last_name":  {"$first": "$last_name"},
                "email":      {"$first": "$email"}
            }},
            {"$project": {
                "_id": 0,
                "faculty_id": 1,
                "first_name": 1,
                "last_name":  1,
                "email":      1
            }},
            {"$sort": {"last_name": 1, "first_name": 1}}
        ]

        async for row in db.faculty_preferences.aggregate(pipeline_prefs, allowDiskUse=True):
            prefs_list.append({
                "faculty_id": row.get("faculty_id"),
                "first_name": row.get("first_name"),
                "last_name":  row.get("last_name"),
                "email":      row.get("email"),
            })

        if prefs_list:
            preferences = prefs_list
        else:
            preferences = f"No faculty preference submissions yet for {active_term_display or '—'}."
    elif selected_term and not kac_ids:
        preferences = f"No matching KAC lists this course for {active_term_display or '—'}."
    else:
        preferences = "No term found."


    # Final return structure
    return {
        "course_id": course_id,
        "course_code": course_code,
        "title": title,
        "qualified_faculty": qualified,
        # Only return the aggregate metrics and top 3 instructors
        "past_instructors_top3": top_3_instructors,
        "past_instructors_remaining_count": remaining_instructors_count,
        "past_instructors_others": other_instructors,  # for expandable list
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
        # "active_term" is the term context used by the report UI.
        # It follows Deloading Utilization's logic: planning (next-after-current) when available.
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
            "ay_demand_visual": ay_demand_visual, # for the chart
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