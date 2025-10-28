import os
from functools import lru_cache
from motor.motor_asyncio import AsyncIOMotorClient
from .config import get_settings
from datetime import datetime

@lru_cache(maxsize=1)
def get_client() -> AsyncIOMotorClient:
    return AsyncIOMotorClient(get_settings().mongodb_uri)

def get_db():
    return get_client().get_default_database()  # db from URI path


from typing import Any, Dict, List, Optional

# ------------------------------
# Teaching History (Mongo/Motor)
# ------------------------------
def _fmt_hhmm(raw: Optional[str]) -> str:
    """'730' → '07:30', '900' → '09:00'."""
    s = (raw or "").strip()
    if not s:
        return ""
    s = s.zfill(4)  # '730' -> '0730'
    return f"{s[:-2]}:{s[-2:]}"

def _derive_room_type_from_room(room_value: Optional[str]) -> Optional[str]:
    val = (room_value or "").strip()
    if val == "" or val.lower() == "online":
        return "Online"
    if val.upper() == "TBA":
        return None
    return "Classroom"

async def fetch_teaching_history(faculty_id: str) -> List[Dict[str, Any]]:
    """
    Joins by business keys (section_id, course_id, term_id).
    Collections:
      - faculty_assignments  { faculty_id, section_id, ... }
      - sections             { section_id, section_code, course_id, term_id, ... }
      - courses              { course_id, course_code: [ ... ], course_title, units, ... }
      - terms                { term_id, ... }
      - section_schedules    { section_id, day, start_time, end_time, room_id?, room?, room_type? }
    """
    db = get_db()

    # 1) assignments for this faculty (ignore archived)
    assignments = await db["faculty_assignments"] \
        .find({"faculty_id": faculty_id, "is_archived": {"$ne": True}}) \
        .to_list(length=None)

    if not assignments:
        return []

    results: List[Dict[str, Any]] = []

    for fa in assignments:
        # 2) section by section_id
        section = await db["sections"].find_one({"section_id": fa["section_id"]})
        if not section:
            continue

        # 3) course & term by business keys
        course = await db["courses"].find_one({"course_id": section.get("course_id")})
        term   = await db["terms"].find_one({"term_id": section.get("term_id")})

        # 4) schedules for this section (join by section_id)
        sched_docs = await db["section_schedules"] \
            .find({"section_id": section["section_id"]}) \
            .to_list(length=None)

        formatted_sched: List[Dict[str, Any]] = []
        for s in sched_docs:
            # prefer stored room_type; fall back to rule if missing
            stored_rt = s.get("room_type")
            room_val = s.get("room") or s.get("room_id")  # you can swap in room_code if you store it
            rt = stored_rt if stored_rt is not None else _derive_room_type_from_room(room_val)

            formatted_sched.append({
                "day": s.get("day"),
                "start_time": _fmt_hhmm(s.get("start_time")),
                "end_time": _fmt_hhmm(s.get("end_time")),
                "room": room_val,
                "room_type": rt,
            })

        # course_code can be an array; choose first element if so
        def _course_code(val):
            if isinstance(val, list):
                return val[0] if val else None
            return val

        results.append({
            # Your terms don’t show a display name; use term_id for now
            "term_id": term["term_id"] if term else None,
            "term_name": (term["term_id"] if term else None),

            "course_code": _course_code(course.get("course_code") if course else None),
            "course_title": course.get("course_title") if course else None,

            "section_code": section.get("section_code"),
            "units": course.get("units") if course else None,

            # Not present in your screenshots; okay to be None
            "modality": None,
            "campus_id": None,

            "schedule": formatted_sched,
        })

    # sort by term → course → section
    results.sort(key=lambda r: (
        (r.get("term_name") or ""),
        (r.get("course_code") or ""),
        (r.get("section_code") or ""),
    ))

    return results


# ------------------------------
# Deloading Utilization Report
# ------------------------------
async def fetch_deloading_utilization(selected_term: str | None = None):
    db = get_db()
    deloadings = await db["deloadings"].find().to_list(None)
    if not deloadings:
        return []

    results = []

    for d in deloadings:
        faculty = await db["faculty_profiles"].find_one({"faculty_id": d["faculty_id"]})
        if not faculty:
            continue

        user = await db["users"].find_one({"user_id": faculty["user_id"]})
        delo_type = await db["deloading_types"].find_one({"type_id": d["type_id"]})
        start_term = await db["terms"].find_one({"term_id": d["start_term"]})
        end_term = await db["terms"].find_one({"term_id": d["end_term"]})

        # Optional filter by term range
        if selected_term:
            if not (start_term and end_term and start_term["term_id"] <= selected_term <= end_term["term_id"]):
                continue

        results.append({
            "faculty_id": faculty["faculty_id"],
            "faculty_name": f"{user.get('first_name', '')} {user.get('last_name', '')}".strip(),
            "deloading_type": delo_type.get("type") if delo_type else None,
            "units_deloaded": d.get("units_deloaded"),
            "approval_status": d.get("approval_status"),
            "start_term": start_term.get("term_id") if start_term else None,
            "end_term": end_term.get("term_id") if end_term else None,
            "updated_at": d.get("updated_at"),
        })

    # Sort results by faculty name ASC, then updated_at DESC
    results.sort(key=lambda x: (x["faculty_name"], -(x["updated_at"].timestamp() if x.get("updated_at") else 0)))
    return results


# ------------------------------------------------------------------------------
#  Part-Time Faculty Risk (Rolling, Predictive) — Sections-First + History-First Allocation
# ------------------------------------------------------------------------------

# ---- Tunables / policy knobs (can be overridden per request) ------------------
DEFAULT_PARAMS = {
    "DEPT_SCOPE": "DEPT0001",
    "overload_allowance_units": 0,      # 0 or 3
    "history_terms_for_experience": 3,  # lookback window
    "units_default_per_section": 3,
    "include_only_with_preferences": False,   # filter FT without prev-term prefs
    "allowed_section_status": ["active", "planned"],
    "allow_fallback_without_sections": False, # guard stops when False and no sections
}

# ---- Term helpers -------------------------------------------------------------
async def current_term(db) -> Optional[Dict[str, Any]]:
    return await db.terms.find_one({"is_current": True})

async def ordered_terms(db) -> List[Dict[str, Any]]:
    # Sort by academic ordering: (acad_year_start asc, term_number asc)
    cur = db.terms.find({}).sort([("acad_year_start", 1), ("term_number", 1)])
    return [t async for t in cur]

async def prev_n_terms(db, term_id: str, N: int) -> List[str]:
    terms = await ordered_terms(db)
    ids = [t["term_id"] for t in terms]
    if term_id not in ids:
        return []
    i = ids.index(term_id)
    start = max(0, i - N)
    return ids[start:i][::-1]  # newest first (most recent just before current)

def _index_of_term(terms: List[Dict[str, Any]], term_id: str) -> int:
    ids = [t["term_id"] for t in terms]
    return ids.index(term_id)

async def term_in_range(db, term_id: str, start_term_id: str, end_term_id: str) -> bool:
    terms = await ordered_terms(db)
    iT = _index_of_term(terms, term_id)
    iS = _index_of_term(terms, start_term_id)
    iE = _index_of_term(terms, end_term_id)
    return iS <= iT <= iE

# ---- Guard / catcher ----------------------------------------------------------
async def ensure_sections_published_or_abort(db, curr: Dict[str, Any], allowed_status: List[str], allow_fallback: bool):
    total = await db.sections.count_documents({
        "term_id": curr["term_id"],
        "is_archived": {"$ne": True},
        "status": {"$in": allowed_status},
    })
    if total == 0 and not allow_fallback:
        raise RuntimeError("PT Risk halted: no current-term sections are published yet.")

# ---- Leaves -------------------------------------------------------------------
async def is_on_approved_leave_now(db, faculty_id: str, curr_term: str) -> bool:
    L = await db.leaves.find_one({
        "faculty_id": faculty_id,
        "approval_status": "APPROVED"
    })
    if not L:
        return False
    return await term_in_range(db, curr_term, L["start_term_id"], L["end_term_id"])

# ---- Course units -------------------------------------------------------------
async def units_per_section(db, course_id: str, units_default: int) -> int:
    C = await db.courses.find_one({"course_id": course_id}, projection={"units_per_section": 1})
    return int(C.get("units_per_section") or units_default) if C else int(units_default)

# ---- Preferences --------------------------------------------------------------
async def preferred_units_for_ft(db, faculty_id: str, pref_term_id: str) -> int:
    P = await db.faculty_preferences.find_one({
        "faculty_id": faculty_id,
        "term_id": pref_term_id
    }, projection={"preferred_units": 1})
    return int(P["preferred_units"]) if P and P.get("preferred_units") is not None else 0

async def has_preference_record(db, faculty_id: str, pref_term_id: str) -> bool:
    count = await db.faculty_preferences.count_documents({"faculty_id": faculty_id, "term_id": pref_term_id})
    return count > 0

# ---- Demand (sections-first, with optional fallbacks) -------------------------
async def demand_sections_sections_first(
    db,
    course_id: str,
    curr_term_id: str,
    allowed_status: List[str],
    units_default: int,
    allow_fallback: bool,
) -> int:
    # Primary: count current-term sections
    count = await db.sections.count_documents({
        "term_id": curr_term_id,
        "course_id": course_id,
        "is_archived": {"$ne": True},
        "status": {"$in": allowed_status},
    })
    if count > 0:
        return int(count)

    if not allow_fallback:
        return 0

    # Fallback A: pre-enlistment seats -> sections (avg cap from recent sections or 40)
    PE = await db.pre_enlistment.find_one({"term_id": curr_term_id, "course_id": course_id})
    if PE and PE.get("seats_requested"):
        # try average historical seat_cap from sections of this course (last 4 terms)
        # if none, use 40
        pipeline = [
            {"$match": {"course_id": course_id, "seat_cap": {"$gt": 0}}},
            {"$group": {"_id": None, "avg_cap": {"$avg": "$seat_cap"}}},
        ]
        agg = [x async for x in db.sections.aggregate(pipeline)]
        avg_cap = int(round(agg[0]["avg_cap"])) if agg else 40
        return int(ceil(float(PE["seats_requested"]) / max(1, avg_cap)))

    # Fallback B: historical realized demand using weighted past sections × fill rates
    # last 3 terms before current
    hist_terms = await prev_n_terms(db, curr_term_id, 3)
    weights = [0.6, 0.3, 0.1]
    est = 0.0
    for idx, t in enumerate(hist_terms):
        secs = await db.sections.count_documents({"term_id": t, "course_id": course_id})
        # compute average fill rate (enrolled / seat_cap)
        pipeline = [
            {"$match": {"term_id": t, "course_id": course_id, "seat_cap": {"$gt": 0}}},
            {"$project": {"fill": {"$divide": ["$enrolled", "$seat_cap"]}}},
            {"$group": {"$id": None, "avg_fill": {"$avg": "$fill"}}},
        ]
        agg = [x async for x in db.sections.aggregate(pipeline)]
        avg_fill = float(agg[0].get("avg_fill", 0.9)) if agg else 0.9
        est += secs * avg_fill * (weights[idx] if idx < len(weights) else 0.0)

    return max(0, round(est))

# ---- Eligibility pools: history-first -> KAC -> dept fallback -----------------
async def taught_in_last_k(db, faculty_id: str, course_id: str, hist_terms: List[str]) -> bool:
    # faculty_assignments joined with sections by section_id
    # We do it in two steps for simplicity/perf
    sec_ids = [s["section_id"] async for s in db.sections.find(
        {"term_id": {"$in": hist_terms}, "course_id": course_id},
        projection={"section_id": 1}
    )]
    if not sec_ids:
        return False
    exists = await db.faculty_assignments.find_one(
        {"faculty_id": faculty_id, "section_id": {"$in": sec_ids}},
        projection={"_id": 1}
    )
    return exists is not None

async def course_kacs(db, course_id: str) -> List[str]:
    c = await db.courses.find_one({"course_id": course_id}, projection={"kac_ids": 1})
    return c.get("kac_ids", []) if c else []

def _intersects(a: List[str], b: List[str]) -> bool:
    return bool(set(a).intersection(set(b)))

async def kac_qualified(db, profile: Dict[str, Any], course_id: str) -> bool:
    # profile may have explicit course_ids from KACs OR qualified_kacs
    course_ids_from_kacs = profile.get("course_ids_from_kacs", [])
    if course_id in course_ids_from_kacs:
        return True
    qualified_kacs = profile.get("qualified_kacs", [])
    return _intersects(qualified_kacs, await course_kacs(db, course_id))

async def eligible_pools(
    db,
    course_id: str,
    curr_term_id: str,
    pref_term_id: str,
    dept_scope: str,
    hist_window: int,
    include_only_with_prefs: bool,
) -> Dict[str, List[Dict[str, Any]]]:
    hist_terms = await prev_n_terms(db, curr_term_id, hist_window)
    history_pool, kac_pool, dept_fallback_pool = [], [], []

    async for fp in db.faculty_profiles.find({"department_id": dept_scope, "employment_type":"FT"}):
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

# ---- Capacity map -------------------------------------------------------------
async def build_capacity_map(
    db,
    curr_term_id: str,
    pref_term_id: str,
    dept_scope: str,
    overload_allowance_units: int,
) -> Dict[str, int]:
    CAP: Dict[str, int] = {}
    async for fp in db.faculty_profiles.find({"department_id": dept_scope, "employment_type":"FT"}, projection={"faculty_id": 1}):
        if await is_on_approved_leave_now(db, fp["faculty_id"], curr_term_id):
            continue
        base = await preferred_units_for_ft(db, fp["faculty_id"], pref_term_id)
        CAP[fp["faculty_id"]] = max(0, base + int(overload_allowance_units))
    return CAP

# ---- Allocation per-course (round-robin; 1 section per turn) ------------------
async def allocate_course(
    db,
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

    # Simple fairness: iterate pools in priority order and take turns
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

    PT_needed = max(0, remaining_sections)
    return {"allocations": allocations, "PT_needed": PT_needed, "units_per_section": ups}

# ---- Faculty Filled names helper -------------------------------------------------------
async def faculty_display_name(db, faculty_id: str) -> str:
    fp = await db.faculty_profiles.find_one(
        {"faculty_id": faculty_id}, projection={"user_id": 1}
    )
    if not fp or not fp.get("user_id"):
        return faculty_id
    u = await db.users.find_one(
        {"user_id": fp["user_id"]}, projection={"first_name": 1, "last_name": 1}
    )
    if not u:
        return faculty_id
    return f"{u.get('first_name','').strip()}, {u.get('last_name','').strip()}".strip(", ")

# ---- Report row builder -------------------------------------------------------
async def build_row(db, course: Dict[str, Any], demand: int, result: Dict[str, Any], CAP_after: Dict[str, int]) -> Dict[str, Any]:
    # FT capacity in sections = sum(CAP_after + allocations units consumed) / ups — we’ll compute directly here
    ups = result["units_per_section"]
    ft_filled_secs = sum(a["sections"] for a in result["allocations"])
    pt_needed = int(result["PT_needed"])

    ft_assignees: list[str] = []
    for a in result["allocations"]:
        name = await faculty_display_name(db, a["faculty_id"])
        ft_assignees.extend([name] * int(a["sections"]))

    risk = "Low"
    confidence = "High"
    if demand > 0 and ft_filled_secs == 0:
        risk, confidence = "High", "Low"
    elif pt_needed > 0:
        risk, confidence = "Medium", "Medium"

    return {
        "course_id": course["course_id"],
        "course_code": course.get("course_code", course["course_id"]),
        "demand_sections": int(demand),
        "ft_filled_sections": int(ft_filled_secs),
        "pt_needed_sections": int(pt_needed),
        "ft_assignees": ft_assignees,
        "risk": risk,
        "confidence": confidence,
    }

# ---- Main run -----------------------------------------------------------------
async def run_pt_risk(
    params: Dict[str, Any] = None
) -> Dict[str, Any]:
    """
    Compute PT-Risk report for a department using MongoDB collections.
    Returns:
      {
        "department_id": "...",
        "term_id": "TERMxxxx",
        "rows": [ ... per course ... ],
        "summary": { "total_pt_sections": n, "estimated_pt_hires": n }
      }
    """
    db = get_db()
    P = {**DEFAULT_PARAMS, **(params or {})}

    CURR = await current_term(db)
    if not CURR:
        raise RuntimeError("No current term found (terms.is_current = true).")
    curr_term_id = CURR["term_id"]

    await ensure_sections_published_or_abort(
        db,
        CURR,
        allowed_status=P["allowed_section_status"],
        allow_fallback=P["allow_fallback_without_sections"],
    )

    prev1 = await prev_n_terms(db, curr_term_id, 1)
    if not prev1:
        raise RuntimeError("Cannot derive previous term for preferences.")
    pref_term_id = prev1[0]

    # Build capacity
    CAP = await build_capacity_map(
        db,
        curr_term_id=curr_term_id,
        pref_term_id=pref_term_id,
        dept_scope=P["DEPT_SCOPE"],
        overload_allowance_units=P["overload_allowance_units"],
    )

    # Iterate courses in scope
    rows: List[Dict[str, Any]] = []
    async for C in db.courses.find({"department_id": P["DEPT_SCOPE"]}):
        demand = await demand_sections_sections_first(
            db,
            C["course_id"],
            curr_term_id=curr_term_id,
            allowed_status=P["allowed_section_status"],
            units_default=P["units_default_per_section"],
            allow_fallback=P["allow_fallback_without_sections"],
        )
        result = await allocate_course(
            db,
            C["course_id"],
            demand_sections=demand,
            CAP=CAP,
            curr_term_id=curr_term_id,
            pref_term_id=pref_term_id,
            dept_scope=P["DEPT_SCOPE"],
            hist_window=P["history_terms_for_experience"],
            units_default=P["units_default_per_section"],
            include_only_with_prefs=P["include_only_with_preferences"],
        )
        if demand > 0:
            rows.append(await build_row(db, C, demand, result, CAP))

    total_pt = sum(r["pt_needed_sections"] for r in rows)
    # naive hires = total_pt (1 PT per section) — adjust as you like
    summary = {"total_pt_sections": total_pt, "estimated_pt_hires": total_pt}

    return {
        "department_id": P["DEPT_SCOPE"],
        "term_id": curr_term_id,
        "rows": rows,
        "summary": summary,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "params": P,
    }