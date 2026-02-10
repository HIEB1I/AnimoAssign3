# analytics/app/OM_REPORTS_ANALYTICS/OM_RP_DeloadingUtilization.py
from typing import Optional, Literal, Dict, Any, List
from fastapi import APIRouter
from collections import defaultdict
import math # Needed for clean division/average calculation
from ..db_async import get_db

Direction = Literal["current", "next", "prev"]
router = APIRouter(tags=["OM: Reports & Analytics – Deloading Utilization"])

async def fetch_deloading_utilization_term_paged(
    anchor_term_id: Optional[str] = None,
    direction: Direction = "current",
) -> Dict[str, Any]:
    """
    Term-paged Deloading Utilization, now with aggregate metrics.
    """
    db = get_db()

    # 1) Load and order all terms (ascending)
    terms_all: List[Dict[str, Any]] = await db["terms"] \
        .find({}, {"_id": 0}) \
        .sort([("acad_year_start", 1), ("term_number", 1)]) \
        .to_list(None)

    # Skip terms that have no deloading records at all.
    # This prevents "empty" academic terms from appearing in the term pager.
    deloading_term_ids = set(
        [str(x or "").strip() for x in await db["deloadings"].distinct("term_id")]
    )
    terms: List[Dict[str, Any]] = [
        t for t in (terms_all or []) if str(t.get("term_id") or "").strip() in deloading_term_ids
    ]

    if not terms:
        return {
            "term": None,
            "rows": [],
            "has_prev": False,
            "has_next": False,
            "terms": [],
            "current_index": None,
            "summary_metrics": {},
        }

    # Pre-shape list for frontend (compact fields only)
    terms_list = [
        {
            "term_id": t.get("term_id"),
            "acad_year_start": t.get("acad_year_start"),
            "term_number": t.get("term_number"),
            "is_current": bool(t.get("is_current")),
        }
        for t in terms
    ]

    # 2) Pick anchor index (prefer current; else latest)
    def find_term_index(tid: str) -> int:
        for i, t in enumerate(terms):
            if t.get("term_id") == tid:
                return i
        return -1

    if anchor_term_id:
        idx = find_term_index(anchor_term_id)
        if idx < 0:
            idx = len(terms) - 1
    else:
        current_idxs = [i for i, t in enumerate(terms) if t.get("is_current") is True]
        # If the DB current term has no deloadings (and thus was filtered out),
        # fall back to the most recent term that has deloadings.
        idx = current_idxs[0] if current_idxs else (len(terms) - 1)

    # 3) Apply direction
    if direction == "next" and idx < len(terms) - 1:
        idx += 1
    elif direction == "prev" and idx > 0:
        idx -= 1

    target_term = terms[idx]
    target_term_id = target_term.get("term_id")

    # 4) Fetch deloadings for the target term
    deloadings = await db["deloadings"].find({"term_id": target_term_id}).to_list(None)

    # --- NEW METRIC CALCULATION START ---
    total_units_deloaded = 0
    faculty_units: Dict[str, float] = defaultdict(float) # faculty_id -> units
    type_breakdown: Dict[str, float] = defaultdict(float) # deloading_type -> units
    
    # 5) Join lookups and simultaneously calculate metrics
    rows: List[Dict[str, Any]] = []
    
    # Cache deloading types and faculty names to avoid redundant DB calls
    type_cache: Dict[str, str] = {}
    faculty_user_cache: Dict[str, Dict[str, Any]] = {}

    for d in deloadings:
        faculty_id = d.get("faculty_id")
        type_id = d.get("type_id") or d.get("deloadingtype_id")
        units = d.get("units_deloaded")
        
        # Aggregate metrics
        if isinstance(units, (int, float)):
            total_units_deloaded += units
            faculty_units[faculty_id] += units

        # Look up deloading type
        if type_id not in type_cache:
            dt = await db["deloading_types"].find_one({
                "$or": [
                    {"type_id": type_id},
                    {"deloadingtype_id": type_id},
                ]
            })
            type_cache[type_id] = (dt or {}).get("type")

        deloading_type_name = type_cache[type_id]
        if deloading_type_name and isinstance(units, (int, float)):
            type_breakdown[deloading_type_name] += units

        # Look up faculty and user
        if faculty_id not in faculty_user_cache:
            faculty = await db["faculty_profiles"].find_one({"faculty_id": faculty_id})
            if faculty:
                user = await db["users"].find_one({"user_id": faculty.get("user_id")})
                faculty_user_cache[faculty_id] = {
                    "faculty": faculty,
                    "user": user,
                    "name": f"{(user or {}).get('first_name','')} {(user or {}).get('last_name','')}".strip() or None
                }
            else:
                faculty_user_cache[faculty_id] = {"faculty": None, "user": None, "name": None}
        
        cached_data = faculty_user_cache.get(faculty_id, {})
        faculty_name = cached_data.get("name")
        
        if not faculty_name:
            continue
            
        rows.append({
            "faculty_id": faculty_id,
            "faculty_name": faculty_name,
            "deloading_type": deloading_type_name,
            "units_deloaded": units,
            "notes": (d.get("notes") or d.get("deloading_notes") or "").strip() or None,
            "approval_status": d.get("approval_status"),
            "term_id": target_term_id,
            "updated_at": d.get("updated_at"),
        })

    total_faculty_deloaded = len(faculty_units)
    average_deloading_per_faculty = (
        total_units_deloaded / total_faculty_deloaded
        if total_faculty_deloaded > 0
        else 0
    )
    
    # Format Deloading Type Breakdown for frontend
    deloading_type_breakdown_list = [
        {"type": t, "units": u} 
        for t, u in type_breakdown.items()
    ]
    
    summary_metrics = {
        "total_units_deloaded": round(total_units_deloaded, 2),
        "total_faculty_deloaded": total_faculty_deloaded,
        "average_deloading_per_faculty": round(average_deloading_per_faculty, 2),
        "deloading_type_breakdown": deloading_type_breakdown_list,
    }
    # --- NEW METRIC CALCULATION END ---

    # Sort: faculty_name asc, then most recent update
    rows.sort(key=lambda x: (x.get("faculty_name") or "", -(x["updated_at"].timestamp() if x.get("updated_at") else 0)))

    # --- Next-term admin risk (Unchanged but remains) -------------------------
    next_term_admin_warnings: List[Dict[str, Any]] = []

    # For warnings, use the true chronological previous term (even if it has no deloadings),
    # so we don't accidentally skip continuity checks.
    prev_term_id: Optional[str] = None
    try:
        cur_term_id_for_prev = target_term_id
        all_idx = next(
            (i for i, t in enumerate(terms_all or []) if t.get("term_id") == cur_term_id_for_prev),
            -1,
        )
        if all_idx > 0:
            prev_term_id = (terms_all[all_idx - 1] or {}).get("term_id")
    except Exception:
        prev_term_id = None

    if prev_term_id:

        prev_term_deloadings = await db["deloadings"].find({"term_id": prev_term_id}).to_list(None)

        for d in prev_term_deloadings:
            type_id = d.get("type_id") or d.get("deloadingtype_id")
            
            # Look up deloading type
            if type_id not in type_cache:
                dt = await db["deloading_types"].find_one({
                    "$or": [
                        {"type_id": type_id},
                        {"deloadingtype_id": type_id},
                    ]
                })
                type_cache[type_id] = (dt or {}).get("type")
            
            deload_type = (type_cache[type_id] or "").strip()

            # Only keep administrative deloadings
            if not deload_type.lower().startswith("admin"):
                continue

            # Look up faculty + user for name
            faculty_id = d.get("faculty_id")
            if faculty_id not in faculty_user_cache:
                faculty = await db["faculty_profiles"].find_one(
                    {"faculty_id": faculty_id}
                )
                if not faculty:
                    continue
                user = await db["users"].find_one(
                    {"user_id": faculty.get("user_id")}
                )
                faculty_user_cache[faculty_id] = {
                    "faculty": faculty,
                    "user": user,
                    "name": f"{(user or {}).get('first_name','')} {(user or {}).get('last_name','')}".strip() or None
                }
            
            cached_data = faculty_user_cache.get(faculty_id, {})
            faculty_name = cached_data.get("name")
            
            if not faculty_name:
                continue

            next_term_admin_warnings.append({
                "faculty_id": faculty_id,
                "faculty_name": faculty_name,
                "deloading_type": deload_type,
                "units": d.get("units_deloaded"),
            })

    return {
        "term": {
            "term_id": target_term.get("term_id"),
            "acad_year_start": target_term.get("acad_year_start"),
            "term_number": target_term.get("term_number"),
            "is_current": bool(target_term.get("is_current")),
        },
        "rows": rows,
        "has_prev": idx > 0,
        "has_next": idx < len(terms) - 1,
        "terms": terms_list,         # all terms for dropdown
        "current_index": idx,        # index of the term you're viewing
        "next_term_admin_warnings": next_term_admin_warnings,
        "summary_metrics": summary_metrics, # NEW
    }

# NOTE: The route setup is in main.py, as noted in the original file.