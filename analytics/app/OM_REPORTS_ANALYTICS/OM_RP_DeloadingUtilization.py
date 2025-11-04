# analytics/app/OM_REPORTS_ANALYTICS/OM_RP_DeloadingUtilization.py
from typing import Optional, Literal, Dict, Any, List
from fastapi import APIRouter
from ..db_async import get_db  # reuse the shared Motor client helpers

Direction = Literal["current", "next", "prev"]
router = APIRouter(tags=["OM: Reports & Analytics – Deloading Utilization"])

async def fetch_deloading_utilization_term_paged(
    anchor_term_id: Optional[str] = None,
    direction: Direction = "current",
) -> Dict[str, Any]:
    """
    Term-paged Deloading Utilization.
    Lifted from db_async.py and moved here, unchanged in behavior.
    """
    db = get_db()

    # 1) Load and order all terms (ascending)
    terms: List[Dict[str, Any]] = await db["terms"] \
        .find({}, {"_id": 0}) \
        .sort([("acad_year_start", 1), ("term_number", 1)]) \
        .to_list(None)

    if not terms:
        return {
            "term": None,
            "rows": [],
            "has_prev": False,
            "has_next": False,
            "terms": [],
            "current_index": None,
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

    # 5) Join lookups
    rows: List[Dict[str, Any]] = []
    for d in deloadings:
        faculty = await db["faculty_profiles"].find_one({"faculty_id": d.get("faculty_id")})
        if not faculty:
            continue
        user = await db["users"].find_one({"user_id": faculty.get("user_id")})
        dt = await db["deloading_types"].find_one({
            "$or": [
                {"type_id": d.get("type_id")},
                {"deloadingtype_id": d.get("type_id")},
            ]
        })
        rows.append({
            "faculty_id": faculty.get("faculty_id"),
            "faculty_name": (f"{(user or {}).get('first_name','')} {(user or {}).get('last_name','')}".strip() or None),
            "deloading_type": (dt or {}).get("type"),
            "units_deloaded": d.get("units_deloaded"),
            "notes": (d.get("notes") or d.get("deloading_notes") or "").strip() or None,
            "approval_status": d.get("approval_status"),
            "term_id": target_term_id,
            "updated_at": d.get("updated_at"),
        })

    # Sort: faculty_name asc, then most recent update
    rows.sort(key=lambda x: (x.get("faculty_name") or "", -(x["updated_at"].timestamp() if x.get("updated_at") else 0)))

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
    }

# NOTE:
# We are NOT declaring a duplicate route here because main.py already exposes
# GET /analytics/deloadings/by-term that the frontend calls.
# The router object is exported (keeps include_router() happy), and the
# function above is imported by main.py to serve the existing path.
