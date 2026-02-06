# analytics/app/OM_REPORTS_ANALYTICS/OM_RP_LoadRisk.py
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple, Literal

from fastapi import APIRouter, HTTPException, Query
from motor.motor_asyncio import AsyncIOMotorDatabase

# Reuse the shared Mongo client/db factory from your project
from ..db_async import get_db  # uses configured AsyncIOMotorClient

router = APIRouter(prefix="/analytics", tags=["Reports & Analytics"])

# ======================== Internal helpers (scoped to Load Risk) ========================

DEFAULT_PARAMS = {
    "DEPT_SCOPE": "DEPT0001",
    "overload_allowance_units": 0,            # 0 or 3
    "history_terms_for_experience": 3,        # lookback window
    "units_default_per_section": 3,
    "include_only_with_preferences": False,   # filter FT without prev-term prefs
    "allowed_section_status": ["active", "planned"],
    "allow_fallback_without_sections": False, # stop if no sections and False
}

Direction = Literal["current", "next", "prev"]

async def current_term(db: AsyncIOMotorDatabase) -> Optional[Dict[str, Any]]:
    return await db.terms.find_one({"is_current": True})

async def ordered_terms(db: AsyncIOMotorDatabase) -> List[Dict[str, Any]]:
    cur = db.terms.find({}).sort([("acad_year_start", 1), ("term_number", 1)])
    return [t async for t in cur]

def _index_of_term(terms: List[Dict[str, Any]], term_id: str) -> int:
    ids = [t["term_id"] for t in terms]
    return ids.index(term_id)

async def prev_n_terms(db: AsyncIOMotorDatabase, term_id: str, N: int) -> List[str]:
    terms = await ordered_terms(db)
    ids = [t["term_id"] for t in terms]
    if term_id not in ids:
        return []
    i = ids.index(term_id)
    start = max(0, i - N)
    return ids[start:i][::-1]  # newest first

async def term_in_range(db: AsyncIOMotorDatabase, term_id: str, start_term_id: str, end_term_id: str) -> bool:
    terms = await ordered_terms(db)
    iT = _index_of_term(terms, term_id)
    iS = _index_of_term(terms, start_term_id)
    iE = _index_of_term(terms, end_term_id)
    return iS <= iT <= iE

async def ensure_sections_published_or_abort(
    db: AsyncIOMotorDatabase,
    term_id: str,
    allowed_status: List[str],  # kept for compatibility, not used now
    allow_fallback: bool,
):
    total = await db.sections.count_documents({
        "term_id": term_id,
        "is_archived": {"$ne": True},  # safe even if is_archived doesn't exist
    })
    if total == 0 and not allow_fallback:
        raise RuntimeError(
            f"PT Risk halted: no sections are published yet for term {term_id}."
        )

async def is_on_approved_leave_now(db: AsyncIOMotorDatabase, faculty_id: str, curr_term: str) -> bool:
    L = await db.leaves.find_one({
        "faculty_id": faculty_id,
        "approval_status": "APPROVED"
    })
    if not L:
        return False
    return await term_in_range(db, curr_term, L["start_term_id"], L["end_term_id"])

async def units_per_section(db: AsyncIOMotorDatabase, course_id: str, units_default: int) -> int:
    """
    Use courses.units_per_section if present; otherwise fall back to courses.units;
    if neither is present, use the global default.
    """
    C = await db.courses.find_one(
        {"course_id": course_id},
        projection={"units_per_section": 1, "units": 1},
    )
    if not C:
        return int(units_default)
    return int(C.get("units_per_section") or C.get("units") or units_default)

async def preferred_units_for_ft(db: AsyncIOMotorDatabase, faculty_id: str, pref_term_id: str) -> int:
    P = await db.faculty_preferences.find_one(
        {"faculty_id": faculty_id, "term_id": pref_term_id},
        projection={"preferred_units": 1}
    )
    return int(P["preferred_units"]) if P and P.get("preferred_units") is not None else 0

async def has_preference_record(db: AsyncIOMotorDatabase, faculty_id: str, pref_term_id: str) -> bool:
    count = await db.faculty_preferences.count_documents({"faculty_id": faculty_id, "term_id": pref_term_id})
    return count > 0

async def taught_in_last_k(db: AsyncIOMotorDatabase, faculty_id: str, course_id: str, hist_terms: List[str]) -> bool:
    sec_ids = [s["section_id"] async for s in db.sections.find(
        {"term_id": {"$in": hist_terms}, "course_id": course_id},
        projection={"section_id": 1}
    )]
    if not sec_ids:
        return False
    exists = await db.faculty_assignments.find_one(
        {"faculty_id": faculty_id, "section_id": {"$in": sec_ids}},
        projection={"__id": 1}
    )
    return exists is not None

async def course_kacs(db: AsyncIOMotorDatabase, course_id: str) -> List[str]:
    c = await db.courses.find_one({"course_id": course_id}, projection={"kac_ids": 1})
    return c.get("kac_ids", []) if c else []

def _intersects(a: List[str], b: List[str]) -> bool:
    return bool(set(a).intersection(set(b)))

async def kac_qualified(db: AsyncIOMotorDatabase, profile: Dict[str, Any], course_id: str) -> bool:
    # Either explicit course_ids_from_kacs, or qualified_kacs ∩ course's kac_ids
    course_ids_from_kacs = profile.get("course_ids_from_kacs", [])
    if course_id in course_ids_from_kacs:
        return True
    qualified_kacs = profile.get("qualified_kacs", [])
    return _intersects(qualified_kacs, await course_kacs(db, course_id))

async def eligible_pools(
    db: AsyncIOMotorDatabase,
    course_id: str,
    curr_term_id: str,
    pref_term_id: str,
    dept_scope: str,
    hist_window: int,
    include_only_with_prefs: bool,
) -> Dict[str, List[Dict[str, Any]]]:
    hist_terms = await prev_n_terms(db, curr_term_id, hist_window)
    history_pool, kac_pool, dept_fallback_pool = [], [], []

    async for fp in db.faculty_profiles.find({"department_id": dept_scope, "employment_type": "FT"}):
        if await is_on_approved_leave_now(db, fp["faculty_id"], curr_term_id):
            continue
        if include_only_with_prefs and not await has_preference_record(db, fp["faculty_id"], pref_term_id):
            continue

        if await taught_in_last_k(db, fp["faculty_id"], course_id, hist_terms):
            history_pool.append(fp)
        elif await kac_qualified(db, fp, course_id):
            kac_pool.append(fp)
        else:
            dept_fallback_pool.append(fp)

    return {
        "history_pool": history_pool,
        "kac_pool": kac_pool,
        "dept_fallback_pool": dept_fallback_pool,
    }

async def build_capacity_map(
    db: AsyncIOMotorDatabase,
    curr_term_id: str,
    pref_term_id: str,
    dept_scope: str,
    overload_allowance_units: int,
) -> Dict[str, int]:
    CAP: Dict[str, int] = {}
    async for fp in db.faculty_profiles.find(
        {"department_id": dept_scope, "employment_type": "FT"},
        projection={"faculty_id": 1}
    ):
        if await is_on_approved_leave_now(db, fp["faculty_id"], curr_term_id):
            continue
        base = await preferred_units_for_ft(db, fp["faculty_id"], pref_term_id)
        CAP[fp["faculty_id"]] = max(0, base + int(overload_allowance_units))
    return CAP

async def allocate_course(
    db: AsyncIOMotorDatabase,
    course_id: str,
    demand_sections: int,
    CAP: Dict[str, int],
    curr_term_id: str,
    pref_term_id: str,
    dept_scope: str,
    hist_window: int,
    units_default: int,
    include_only_with_prefs: bool,
) -> Dict[str, Any]:
    ups = await units_per_section(db, course_id, units_default)
    remaining_sections = int(demand_sections)
    allocations: List[Dict[str, Any]] = []
    pools = await eligible_pools(
        db, course_id, curr_term_id, pref_term_id, dept_scope, hist_window, include_only_with_prefs
    )

    def total_eligible_capacity_sections() -> int:
        total = 0
        for pool_name in ["history_pool", "kac_pool", "dept_fallback_pool"]:
            for fp in pools[pool_name]:
                total += (CAP.get(fp["faculty_id"], 0) // ups)
        return total

    while remaining_sections > 0:
        if total_eligible_capacity_sections() <= 0:
            break
        progress = False
        for pool_name in ["history_pool", "kac_pool", "dept_fallback_pool"]:
            for fp in pools[pool_name]:
                fid = fp["faculty_id"]
                if CAP.get(fid, 0) >= ups and remaining_sections > 0:
                    allocations.append({"faculty_id": fid, "course_id": course_id, "sections": 1})
                    CAP[fid] = CAP.get(fid, 0) - ups
                    remaining_sections -= 1
                    progress = True
                    if remaining_sections == 0:
                        break
            if remaining_sections == 0:
                break
        if not progress:
            break

    return {"allocations": allocations, "PT_needed": max(0, remaining_sections), "units_per_section": ups}

async def faculty_display_name(db: AsyncIOMotorDatabase, faculty_id: str) -> str:
    fp = await db.faculty_profiles.find_one({"faculty_id": faculty_id}, projection={"user_id": 1})
    if not fp or not fp.get("user_id"):
        return faculty_id
    u = await db.users.find_one({"user_id": fp["user_id"]}, projection={"first_name": 1, "last_name": 1})
    if not u:
        return faculty_id
    return f"{u.get('first_name','').strip()}, {u.get('last_name','').strip()}".strip(", ")

async def build_row(
    db: AsyncIOMotorDatabase,
    course: Dict[str, Any],
    demand: int,
    result: Dict[str, Any],
    CAP_after: Dict[str, int]
) -> Dict[str, Any]:
    ups = result["units_per_section"]
    ft_filled_secs = sum(a["sections"] for a in result["allocations"])
    pt_needed = int(result["PT_needed"])

    ft_assignees: list[str] = []
    for a in result["allocations"]:
        name = await faculty_display_name(db, a["faculty_id"])
        ft_assignees.extend([name] * int(a["sections"]))

    risk, confidence = "Low", "100%"
    if demand > 0 and ft_filled_secs == 0:
        risk, confidence = "High", "30%"
    elif pt_needed > 0:
        risk, confidence = "Medium", "70%"

    # course_code can be a string or a list (e.g., ["ADANI-1"])
    raw_code = course.get("course_code", course["course_id"])
    if isinstance(raw_code, list):
        course_code = raw_code[0] if raw_code else course["course_id"]
    else:
        course_code = raw_code

    return {
        "course_id": course["course_id"],
        "course_code": course_code,
        "demand_sections": int(demand),
        "ft_filled_sections": int(ft_filled_secs),
        "pt_needed_sections": int(pt_needed),
        "ft_assignees": ft_assignees,
        "risk": risk,
        "confidence": confidence,
    }

# ======================== Public compute function (importable) ========================

async def run_pt_risk(params: Dict[str, Any] | None = None) -> Dict[str, Any]:
    db = get_db()
    P = {**DEFAULT_PARAMS, **(params or {})}

    # 1) Get the current term (is_current = true)
    curr = await current_term(db)
    if not curr:
        raise RuntimeError("No current term found (terms.is_current = true).")
    curr_term_id = curr["term_id"]

    # 2) Find the NEXT term after the current term
    terms = await ordered_terms(db)
    idx = _index_of_term(terms, curr_term_id)
    if idx >= len(terms) - 1:
        # No next term configured
        raise RuntimeError(
            "PT Risk halted: current term has no NEXT term configured."
        )

    next_term = terms[idx + 1]
    risk_term_id = next_term["term_id"]  # <-- PT risk is for this term
    # --- New: Fetching Term Display Details ---
    term_display_details = {
        "acad_year_start": next_term.get("acad_year_start", "N/A"),
        "end_at": next_term.get("end_at", "N/A"),
        "term_number": next_term.get("term_number", "N/A"),
    }
    # -----------------------------------------

    # 3) Ensure NEXT-term sections exist / are published
    await ensure_sections_published_or_abort(
        db,
        term_id=risk_term_id,
        allowed_status=P["allowed_section_status"],
        allow_fallback=P["allow_fallback_without_sections"],
    )

    # For this model we look at NEXT-term preferences for capacity
    pref_term_id = risk_term_id

    CAP = await build_capacity_map(
        db,
        curr_term_id=risk_term_id,
        pref_term_id=pref_term_id,
        dept_scope=P["DEPT_SCOPE"],
        overload_allowance_units=P["overload_allowance_units"],
    )

    rows: List[Dict[str, Any]] = []
    # --- New: Fetching Department Display Name ---
    dept = await db.departments.find_one({"department_id": P["DEPT_SCOPE"]}, projection={"department_name": 1})
    dept_name = dept.get("department_name", P["DEPT_SCOPE"]) if dept else P["DEPT_SCOPE"]
    # ---------------------------------------------

    async for C in db.courses.find({"department_id": P["DEPT_SCOPE"]}):
        demand = await _demand_sections_sections_first(
            db,
            course_id=C["course_id"],
            curr_term_id=risk_term_id,  # <-- use NEXT term here
            allowed_status=P["allowed_section_status"],
            units_default=P["units_default_per_section"],
            allow_fallback=P["allow_fallback_without_sections"],
        )

        # CAP is modified in place inside allocate_course
        result = await allocate_course(
            db,
            course_id=C["course_id"],
            demand_sections=demand,
            CAP=CAP,
            curr_term_id=risk_term_id,
            pref_term_id=pref_term_id,
            dept_scope=P["DEPT_SCOPE"],
            hist_window=P["history_terms_for_experience"],
            units_default=P["units_default_per_section"],
            include_only_with_prefs=P["include_only_with_preferences"],
        )

        if demand > 0:
            rows.append(await build_row(db, C, demand, result, CAP))

    # --- New Risk Aggregation Logic ---
    total_pt = sum(r["pt_needed_sections"] for r in rows)
    high_risk_count = sum(1 for r in rows if r["risk"] == "High")
    medium_risk_count = sum(1 for r in rows if r["risk"] == "Medium")
    
    total_confidence = 0
    valid_confidence_count = 0
    for r in rows:
        conf_str = r["confidence"].replace('%', '').strip()
        try:
            confidence_val = int(conf_str)
            total_confidence += confidence_val
            valid_confidence_count += 1
        except ValueError:
            # Ignore non-numerical confidence scores
            pass

    avg_confidence = round(total_confidence / valid_confidence_count) if valid_confidence_count > 0 else 0
    # ---------------------------------

    summary = {
        "total_pt_sections": total_pt,
        "estimated_pt_hires": total_pt,
        "high_risk_course_count": high_risk_count,
        "medium_risk_course_count": medium_risk_count,
        "avg_confidence_score": avg_confidence, # New aggregated metric
    }

    return {
        "department_id": P["DEPT_SCOPE"],
        "dept_name": dept_name, # NEW
        "term_id": risk_term_id,  # report is for NEXT term
        **term_display_details, # NEW
        "rows": rows,
        "summary": summary,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "params": P,
    }

# keep the demand estimator as a tiny wrapper for clarity
import math
async def _demand_sections_sections_first(
    db: AsyncIOMotorDatabase,
    course_id: str,
    curr_term_id: str,
    allowed_status: List[str],  # still accepted, but unused
    units_default: int,
    allow_fallback: bool,
) -> int:
    """
    Demand estimator:

    1) Primary: count current-term sections for this course (any non-archived).
    2) If zero and allow_fallback is True: use weighted history of sections and
       fill rates from previous terms, based only on sections/enrollment_cap.
    """
    # Primary: count current-term sections for this course (any status)
    count = await db.sections.count_documents({
        "term_id": curr_term_id,
        "course_id": course_id,
        "is_archived": {"$ne": True},  # safe if field doesn't exist
    })
    if count > 0:
        return int(count)
    if not allow_fallback:
        return 0

    # Fallback: weighted history (last 3 terms × fill rate)
    weights = [0.6, 0.3, 0.1]
    est = 0.0
    hist_terms = await prev_n_terms(db, curr_term_id, 3)
    for idx, t in enumerate(hist_terms):
        secs = await db.sections.count_documents({"term_id": t, "course_id": course_id})
        if secs == 0:
            continue
        agg = [x async for x in db.sections.aggregate([
            {
                "$match": {
                    "term_id": t,
                    "course_id": course_id,
                    "enrollment_cap": {"$gt": 0},
                }
            },
            {
                "$project": {
                    "fill": {
                        "$divide": ["$enrolled", "$enrollment_cap"]
                    }
                }
            },
            {
                "$group": {
                    "_id": None,
                    "avg_fill": {"$avg": "$fill"}
                }
            },
        ])]
        avg_fill = float(agg[0].get("avg_fill", 0.9)) if agg else 0.9
        weight = weights[idx] if idx < len(weights) else 0.0
        est += secs * avg_fill * weight

    return max(0, round(est))

# ======================== Departments helper endpoint (Phase 0) ========================
@router.get("/departments")
async def list_departments():
    """
    Returns departments for dropdown selection.
    Uses department_id internally, shows dept_name in UI.
    """
    db = get_db()
    items: list[dict[str, str]] = []


    async for dep in db.departments.find(
        {},
        projection={"department_id": 1, "dept_name": 1}
    ).sort("dept_name", 1):
        did = dep.get("department_id")
        name = dep.get("dept_name") or did
        if did:
            items.append({
            "department_id": did,
            "department_name": name, # normalized key for frontend
            })

    return {"departments": items}

# ======================== Router endpoint ========================

@router.get("/pt-risk")
async def pt_risk_endpoint(
    department_id: str = Query("DEPT0001"),
    overload_allowance_units: int = Query(0, description="0 or 3"),
    history_terms_for_experience: int = Query(3),
    include_only_with_preferences: bool = Query(False),
    allow_fallback_without_sections: bool = Query(False),
):
    try:
        return await run_pt_risk({
            "DEPT_SCOPE": department_id,
            "overload_allowance_units": overload_allowance_units,
            "history_terms_for_experience": history_terms_for_experience,
            "include_only_with_preferences": include_only_with_preferences,
            "allow_fallback_without_sections": allow_fallback_without_sections,
        })
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))


__all__ = ["router", "run_pt_risk"]