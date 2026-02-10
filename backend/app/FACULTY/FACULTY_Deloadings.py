from typing import Optional, Literal, Dict, Any, List
from fastapi import APIRouter, Query
from ..main import db  # shared Motor client/database

Direction = Literal["current", "next", "prev"]

router = APIRouter(prefix="/faculty/deloadings", tags=["FACULTY: Deloadings"])

async def _terms_list_for_faculty(faculty_id: str) -> List[Dict[str, Any]]:
    """Return only academic terms that have deloadings for the given faculty.

    This ensures the UI will not show terms that would have an empty deloadings
    table for the faculty.
    """
    term_ids = await db["deloadings"].distinct("term_id", {"faculty_id": faculty_id})
    term_ids = [tid for tid in (term_ids or []) if tid]
    if not term_ids:
        return []

    terms: List[Dict[str, Any]] = await db["terms"] \
        .find({"term_id": {"$in": term_ids}}, {"_id": 0}) \
        .sort([("acad_year_start", 1), ("term_number", 1)]) \
        .to_list(None)
    return terms

def _term_lite(t: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "term_id": t.get("term_id"),
        "acad_year_start": t.get("acad_year_start"),
        "term_number": t.get("term_number"),
        "is_current": bool(t.get("is_current")),
    }

@router.get("")
async def by_term(
    userId: str = Query(..., description="Logged-in user ID"),
    anchor_term_id: Optional[str] = Query(None),
    direction: Direction = Query("current"),
):
    """
    Term-paged faculty deloadings scoped to a single faculty (the logged-in user).
    Mirrors OM-RP Deloading Utilization paging, but filtered to the caller.
    """
    # Resolve faculty_id for this user
    faculty = await db["faculty_profiles"].find_one({"user_id": userId})
    if not faculty:
        # Try a fallback through users -> email mapping if needed
        user = await db["users"].find_one({"user_id": userId})
        if user:
            faculty = await db["faculty_profiles"].find_one({"email": user.get("email")})
    faculty_id = (faculty or {}).get("faculty_id")

    # If we cannot resolve the caller to a faculty profile, we cannot scope
    # deloadings (and should not show unrelated terms).
    if not faculty_id:
        return {
            "term": None,
            "rows": [],
            "has_prev": False,
            "has_next": False,
            "terms": [],
            "current_index": None,
        }

    # Only return academic terms where the faculty actually has deloadings.
    terms = await _terms_list_for_faculty(faculty_id)
    if not terms:
        return {
            "term": None,
            "rows": [],
            "has_prev": False,
            "has_next": False,
            "terms": [],
            "current_index": None,
        }

    # Anchor selection
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

    # Apply direction
    if direction == "next" and idx < len(terms) - 1:
        idx += 1
    elif direction == "prev" and idx > 0:
        idx -= 1

    target_term = terms[idx]
    target_term_id = target_term.get("term_id")

    # Fetch deloadings for this faculty + term
    rows: List[Dict[str, Any]] = []
    deloadings = await db["deloadings"].find({
        "term_id": target_term_id,
        "faculty_id": faculty_id,
    }).to_list(None)

    for d in deloadings:
        dt = await db["deloading_types"].find_one({
            "$or": [
                {"type_id": d.get("type_id")},
                {"deloadingtype_id": d.get("type_id")},
            ]
        })
        rows.append({
            "deloading_type": (dt or {}).get("type"),
            "units_deloaded": d.get("units_deloaded"),
            "notes": (d.get("notes") or d.get("deloading_notes") or "").strip() or None,
            "term_id": target_term_id,
            "updated_at": d.get("updated_at"),
        })

    # Sort: by most recent update desc
    rows.sort(key=lambda x: -(x["updated_at"].timestamp() if x.get("updated_at") else 0))

    return {
        "term": _term_lite(target_term),
        "rows": rows,
        "has_prev": idx > 0,
        "has_next": idx < len(terms) - 1,
        "terms": [_term_lite(t) for t in terms],
        "current_index": idx,
    }
