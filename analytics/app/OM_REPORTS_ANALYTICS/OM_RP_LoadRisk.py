# analytics/app/OM_REPORTS_ANALYTICS/OM_RP_LoadRisk.py
from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional, Literal

from fastapi import APIRouter, HTTPException, Query
from motor.motor_asyncio import AsyncIOMotorDatabase

from ..db_async import get_db  # your shared db factory

router = APIRouter(prefix="/analytics", tags=["Reports & Analytics"])

RiskLevel = Literal["RISK", "WARNING", "SAFE"]

DEFAULT_PARAMS = {
    "DEPT_SCOPE": "DEPT0001",
    "suggest_top_n": 3,
}

COL_USERS = "users"
COL_FACULTY = "faculty_profiles"
COL_ASSIGN = "faculty_assignments"
COL_SECTIONS = "sections"
COL_SECTIONS_SUBMITTED = "sections_submitted"
COL_DEPARTMENTS = "departments"
COL_COURSES = "courses"
COL_TERMS = "terms"
COL_LEAVES = "leaves"
COL_KACS = "kacs"
COL_FACULTY_PREFS = "faculty_preferences"

# -----------------------------
# Term helpers
# -----------------------------
async def ordered_terms(db: AsyncIOMotorDatabase) -> List[Dict[str, Any]]:
    cur = db[COL_TERMS].find({}).sort([("acad_year_start", 1), ("term_number", 1)])
    return [t async for t in cur]

async def current_term(db: AsyncIOMotorDatabase) -> Optional[Dict[str, Any]]:
    return await db[COL_TERMS].find_one({"is_current": True})

async def next_term(db: AsyncIOMotorDatabase) -> Optional[Dict[str, Any]]:
    cur = await current_term(db)
    if not cur or not cur.get("term_id"):
        return None

    terms = await ordered_terms(db)
    try:
        i = _index_of_term(terms, cur["term_id"])
    except Exception:
        return None

    if not terms:
        return None
    nxt = terms[i + 1] if (i + 1) < len(terms) else terms[0]
    return nxt

def _index_of_term(terms: List[Dict[str, Any]], term_id: str) -> int:
    ids = [t["term_id"] for t in terms]
    return ids.index(term_id)

async def term_in_range(db: AsyncIOMotorDatabase, term_id: str, start_term_id: str, end_term_id: str) -> bool:
    terms = await ordered_terms(db)
    iT = _index_of_term(terms, term_id)
    iS = _index_of_term(terms, start_term_id)
    iE = _index_of_term(terms, end_term_id)
    return iS <= iT <= iE

async def is_on_approved_leave(db: AsyncIOMotorDatabase, faculty_id: str, term_id: str) -> bool:
    """Return True if ANY approved leave record overlaps the given term."""
    try:
        cur = db[COL_LEAVES].find(
            {"faculty_id": faculty_id, "approval_status": "APPROVED"},
            projection={"start_term_id": 1, "end_term_id": 1},
        )
        async for L in cur:
            st = L.get("start_term_id")
            en = L.get("end_term_id")
            if not st or not en:
                continue
            if await term_in_range(db, term_id, st, en):
                return True
    except Exception:
        # be conservative: if leave data can't be read, treat as not on leave
        return False
    return False

async def resolve_baseline_term(db: AsyncIOMotorDatabase, target_term: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Baseline = same term_number, previous acad year."""
    try:
        tnum = int(target_term.get("term_number"))
        ay = int(target_term.get("acad_year_start"))
    except Exception:
        return None
    return await db[COL_TERMS].find_one({"acad_year_start": ay - 1, "term_number": tnum})

async def get_term_by_ay_term(db: AsyncIOMotorDatabase, acad_year_start: int, term_number: int) -> Optional[Dict[str, Any]]:
    return await db[COL_TERMS].find_one({"acad_year_start": acad_year_start, "term_number": term_number})


async def build_recent_ft_pool_map(
    db: AsyncIOMotorDatabase,
    dept_id: str,
    baseline_term_id: str,
    target_term_id: str,
) -> Dict[str, Dict[str, Any]]:
    """
    Build a recent FT pool per course using the terms from the most recent offering
    of the course back to the baseline term (inclusive).
    """
    terms = await ordered_terms(db)
    if not terms:
        return {}

    try:
        i_baseline = _index_of_term(terms, baseline_term_id)
        i_target = _index_of_term(terms, target_term_id)
    except Exception:
        return {}

    if i_baseline > i_target:
        return {}

    window_terms = terms[i_baseline:i_target]
    window_term_ids = [t.get("term_id") for t in window_terms if t.get("term_id")]
    if not window_term_ids:
        return {}

    course_ids = [
        c["course_id"]
        async for c in db[COL_COURSES].find(
            {"$or": [{"department_id": dept_id}, {"dept_id": dept_id}]},
            projection={"course_id": 1},
        )
        if c.get("course_id")
    ]
    if not course_ids:
        return {}

    sec_cur = db[COL_SECTIONS].find(
        {
            "term_id": {"$in": window_term_ids},
            "course_id": {"$in": course_ids},
            "is_archived": {"$ne": True},
        },
        projection={"section_id": 1, "course_id": 1, "term_id": 1},
    )
    secs = [s async for s in sec_cur]
    if not secs:
        return {}

    sec_by_id = {s["section_id"]: s for s in secs if s.get("section_id")}
    assign_cur = db[COL_ASSIGN].find(
        {"section_id": {"$in": list(sec_by_id.keys())}},
        projection={"faculty_id": 1, "section_id": 1},
    )
    assigns = [a async for a in assign_cur]

    faculty_ids = sorted({a.get("faculty_id") for a in assigns if a.get("faculty_id")})
    emp_map: Dict[str, str] = {}
    if faculty_ids:
        async for fp in db[COL_FACULTY].find(
            {"faculty_id": {"$in": faculty_ids}},
            projection={"faculty_id": 1, "employment_type": 1},
        ):
            fid = fp.get("faculty_id")
            if fid:
                emp_map[fid] = str(fp.get("employment_type") or "").strip().upper()

    name_cache: Dict[str, str] = {}
    async def fname(fid: str) -> str:
        if fid in name_cache:
            return name_cache[fid]
        val = await faculty_display_name(db, fid)
        name_cache[fid] = val
        return val

    by_course: Dict[str, Dict[str, Any]] = {}
    for cid in course_ids:
        by_course[cid] = {"latest_ft_pool_ids": [], "latest_ft_pool": [], "pool_timeline": [], "latest_offered_term_id": None}

    term_order = {tid: idx for idx, tid in enumerate(window_term_ids)}
    course_term_ft_ids: Dict[str, Dict[str, set[str]]] = {}
    offered_terms_by_course: Dict[str, set[str]] = {}

    for a in assigns:
        sid = a.get("section_id")
        fid = a.get("faculty_id")
        if not sid or not fid:
            continue
        s = sec_by_id.get(sid)
        if not s:
            continue
        cid = s.get("course_id")
        tid = s.get("term_id")
        if not cid or not tid:
            continue
        offered_terms_by_course.setdefault(cid, set()).add(tid)
        if emp_map.get(fid) == 'FT':
            course_term_ft_ids.setdefault(cid, {}).setdefault(tid, set()).add(fid)

    for cid in course_ids:
        offered = sorted(list(offered_terms_by_course.get(cid, set())), key=lambda tid: term_order.get(tid, -1))
        if not offered:
            continue
        latest_tid = offered[-1]
        latest_idx = term_order.get(latest_tid, -1)
        baseline_idx = term_order.get(baseline_term_id, -1)
        if latest_idx < 0 or baseline_idx < 0:
            continue

        pool_ids: set[str] = set()
        timeline: List[Dict[str, Any]] = []
        for idx in range(latest_idx, baseline_idx - 1, -1):
            tid = window_term_ids[idx]
            term_doc = window_terms[idx]
            ft_ids = sorted(list(course_term_ft_ids.get(cid, {}).get(tid, set())))
            ft_names = [await fname(fid) for fid in ft_ids]
            offered_now = tid in offered_terms_by_course.get(cid, set())
            timeline.append({
                "term_id": tid,
                "acad_year_start": term_doc.get("acad_year_start"),
                "term_number": term_doc.get("term_number"),
                "offered": bool(offered_now),
                "faculty_ids": ft_ids,
                "faculty_names": ft_names,
            })
            pool_ids.update(ft_ids)

        pool_names = [await fname(fid) for fid in sorted(pool_ids)]
        by_course[cid] = {
            "latest_offered_term_id": latest_tid,
            "latest_ft_pool_ids": sorted(pool_ids),
            "latest_ft_pool": pool_names,
            "pool_timeline": timeline,
        }

    return by_course

# -----------------------------
# Course / faculty helpers
# -----------------------------
async def units_per_section(db: AsyncIOMotorDatabase, course_id: str, default_units: int = 3) -> int:
    c = await db[COL_COURSES].find_one({"course_id": course_id}, projection={"units": 1})
    if not c:
        return int(default_units)
    return int(c.get("units") or default_units)

async def faculty_display_name(db: AsyncIOMotorDatabase, faculty_id: str) -> str:
    fp = await db[COL_FACULTY].find_one({"faculty_id": faculty_id}, projection={"user_id": 1})
    if not fp or not fp.get("user_id"):
        return faculty_id
    u = await db[COL_USERS].find_one({"user_id": fp["user_id"]}, projection={"first_name": 1, "last_name": 1})
    if not u:
        return faculty_id
    return f"{(u.get('first_name') or '').strip()} {(u.get('last_name') or '').strip()}".strip() or faculty_id

async def faculty_capacity_units(db: AsyncIOMotorDatabase, faculty_id: str, term_id: str) -> int:
    """
    Capacity units used by Load Risk.

    Priority:
    1) faculty_preferences.preferred_units (or load_units) for the target term
    2) faculty_profiles.min_units (if present and >0)
    3) sensible default: FT=12, PT=0

    Rationale: many profiles store min_units as blank/0 in seeded data, which would incorrectly
    drive capacity to 0 and inflate "RISK" counts.
    """

    def _to_int(x: Any) -> Optional[int]:
        if x is None:
            return None
        if isinstance(x, bool):
            return int(x)
        if isinstance(x, (int, float)):
            return int(x)
        s = str(x).strip()
        if not s:
            return None
        try:
            return int(float(s))
        except Exception:
            return None

    pref = await db[COL_FACULTY_PREFS].find_one(
        {"faculty_id": faculty_id, "term_id": term_id},
        projection={"preferred_units": 1, "load_units": 1},
    )

    for k in ("preferred_units", "load_units"):
        if pref and pref.get(k) is not None:
            v = _to_int(pref.get(k))
            if v is not None and v >= 0:
                return int(v)

    fp = await db[COL_FACULTY].find_one(
        {"faculty_id": faculty_id},
        projection={"min_units": 1, "employment_type": 1},
    ) or {}

    emp = str(fp.get("employment_type") or "").strip().upper()
    mu = _to_int(fp.get("min_units"))

    if mu is not None and mu > 0:
        return int(mu)

    # Default fallback (align with Load Assignment expectations)
    if emp == "FT":
        return 12
    return 0

async def faculty_employment_type(db: AsyncIOMotorDatabase, faculty_id: str) -> str:
    fp = await db[COL_FACULTY].find_one({"faculty_id": faculty_id}, projection={"employment_type": 1})
    return (fp.get("employment_type") or "").strip() if fp else ""

async def get_deload_units(db: AsyncIOMotorDatabase, faculty_id: str, term_id: str) -> int:
    """Best-effort deload lookup across common collection/field variants."""
    field_candidates = [
        "units_deloaded",
        "units",
        "deload_units",
        "deloading_units",
        "units_deloading",
    ]
    for col in ["deloadings", "deloading", "faculty_deloadings"]:
        try:
            doc = await db[col].find_one({"faculty_id": faculty_id, "term_id": term_id})
            if not doc:
                continue
            for f in field_candidates:
                if doc.get(f) is not None:
                    try:
                        return int(float(str(doc.get(f)).strip() or 0))
                    except Exception:
                        continue
        except Exception:
            continue
    return 0

async def taught_in_term(db: AsyncIOMotorDatabase, faculty_id: str, term_id: str) -> bool:
    sec_ids = [
        s["section_id"]
        async for s in db[COL_SECTIONS].find({"term_id": term_id}, projection={"section_id": 1})
        if s.get("section_id")
    ]
    if not sec_ids:
        return False
    x = await db[COL_ASSIGN].find_one(
        {"faculty_id": faculty_id, "section_id": {"$in": sec_ids}},
        projection={"_id": 1},
    )
    return x is not None

# -----------------------------
# KAC helper (optional)
# -----------------------------
def _intersects(a: List[str], b: List[str]) -> bool:
    return bool(set(a).intersection(set(b)))

async def course_kacs(db: AsyncIOMotorDatabase, course_id: str) -> List[str]:
    cur = db[COL_KACS].find({"course_list": course_id}, projection={"kac_id": 1})
    return [k.get("kac_id") async for k in cur if k.get("kac_id")]

async def kac_qualified(db: AsyncIOMotorDatabase, profile: Dict[str, Any], course_id: str) -> bool:
    course_ids_from_kacs = profile.get("course_ids_from_kacs", [])
    if course_id in course_ids_from_kacs:
        return True
    qualified_kacs = profile.get("qualified_kacs", [])
    return _intersects(qualified_kacs, await course_kacs(db, course_id))

# -----------------------------
# Core computation
# -----------------------------
async def build_baseline_course_map(
    db: AsyncIOMotorDatabase,
    dept_id: str,
    baseline_term_id: str,
) -> Dict[str, Dict[str, Any]]:
    course_ids = [
        c["course_id"]
        async for c in db[COL_COURSES].find(
            {"$or": [{"department_id": dept_id}, {"dept_id": dept_id}]},
            projection={"course_id": 1},
        )
        if c.get("course_id")
    ]

    sec_cur = db[COL_SECTIONS].find(
        {"term_id": baseline_term_id, "course_id": {"$in": course_ids}, "is_archived": {"$ne": True}},
        projection={"section_id": 1, "course_id": 1, "section_code": 1, "section": 1},
    )
    secs = [s async for s in sec_cur]
    sec_by_id = {s["section_id"]: s for s in secs if s.get("section_id")}
    by_course: Dict[str, Dict[str, Any]] = {}

    # init per-course containers + demand
    for s in secs:
        cid = s.get("course_id")
        if not cid:
            continue
        by_course.setdefault(
            cid,
            {
                "demand_sections": 0,
                "baseline_ft_faculty_ids": set(),
                "baseline_ft_sections_by_faculty": {},
                "baseline_sections": [],  # <-- section-level baseline list
                "relied_on_pt_last_year": False,
            },
        )
        by_course[cid]["demand_sections"] += 1

    if not sec_by_id:
        return by_course

    # assignments for those sections
    assign_cur = db[COL_ASSIGN].find(
        {"section_id": {"$in": list(sec_by_id.keys())}},
        projection={"faculty_id": 1, "section_id": 1},
    )
    assigns = [a async for a in assign_cur]

    # section -> faculty
    sec_to_faculty: Dict[str, str] = {}
    for a in assigns:
        sid = a.get("section_id")
        fid = a.get("faculty_id")
        if sid and fid:
            sec_to_faculty[sid] = fid

    emp_cache: Dict[str, str] = {}
    async def emp(fid: str) -> str:
        if fid in emp_cache:
            return emp_cache[fid]
        t = await faculty_employment_type(db, fid)
        emp_cache[fid] = t
        return t

    # build per-section rows
    for sid, sdoc in sec_by_id.items():
        cid = sdoc.get("course_id")
        if not cid:
            continue

        by_course.setdefault(
            cid,
            {
                "demand_sections": 0,
                "baseline_ft_faculty_ids": set(),
                "baseline_ft_sections_by_faculty": {},
                "baseline_sections": [],
                "relied_on_pt_last_year": False,
            },
        )

        section_code = sdoc.get("section_code") or sdoc.get("section") or sid
        fid = sec_to_faculty.get(sid)

        if not fid:
            by_course[cid]["baseline_sections"].append(
                {
                    "course_id": cid, 
                    "section_id": sid,
                    "section_code": section_code,
                    "faculty_id": None,
                    "employment_type": None,
                }
            )
            continue

        et = (await emp(fid)).upper()
        by_course[cid]["baseline_sections"].append(
            {
                "course_id": cid, 
                "section_id": sid,
                "section_code": section_code,
                "faculty_id": fid,
                "employment_type": et,
            }
        )

        if et == "FT":
            by_course[cid]["baseline_ft_faculty_ids"].add(fid)
            m = by_course[cid]["baseline_ft_sections_by_faculty"]
            m[fid] = int(m.get(fid, 0)) + 1
        elif et == "PT":
            by_course[cid]["relied_on_pt_last_year"] = True

    return by_course

async def compute_course_row(
    db: AsyncIOMotorDatabase,
    dept_id: str,
    course_id: str,
    course_code: str,
    course_title: str,
    baseline_demand: int,
    baseline_ft_ids: List[str],
    latest_ft_pool_ids: List[str],
    latest_ft_pool_names: Optional[List[str]],
    pool_timeline: Optional[List[Dict[str, Any]]],
    latest_offered_term_id: Optional[str],
    relied_on_pt_last_year: bool,
    baseline_term: Dict[str, Any],
    target_term: Dict[str, Any],
    suggest_top_n: int,
    baseline_ft_sections_by_faculty: Optional[Dict[str, int]] = None,
    baseline_sections: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    # Active-check terms per your rule:
    # active if taught in AY(baseline) Term 3 OR AY(target) Term 1
    try:
        base_ay = int(baseline_term.get("acad_year_start"))
        targ_ay = int(target_term.get("acad_year_start"))
    except Exception:
        base_ay = 0
        targ_ay = 0

    base_t3 = await get_term_by_ay_term(db, base_ay, 3) if base_ay else None
    targ_t1 = await get_term_by_ay_term(db, targ_ay, 1) if targ_ay else None

    active_terms: List[str] = []
    if base_t3 and base_t3.get("term_id"):
        active_terms.append(base_t3["term_id"])
    if targ_t1 and targ_t1.get("term_id"):
        active_terms.append(targ_t1["term_id"])

    # safety fallback so you don't get "all inactive => all zero" when terms aren't present
    if not active_terms and target_term and target_term.get("term_id"):
        active_terms = [target_term["term_id"]]

    ups = await units_per_section(db, course_id, 3)

    baseline_ft_sections_by_faculty = baseline_ft_sections_by_faculty or {}
    baseline_sections = baseline_sections or []
    latest_ft_pool_ids = [fid for fid in (latest_ft_pool_ids or []) if fid]
    latest_ft_pool_names = latest_ft_pool_names or []
    pool_timeline = pool_timeline or []

    # Only sections for this course + stable ordering
    baseline_sections = [s for s in baseline_sections if (s.get("course_id") == course_id)]
    baseline_sections.sort(key=lambda x: str(x.get("section_code") or x.get("section_id") or ""))

    # -----------------------------------------
    # Build per-faculty state (leave, active, capacity)
    # -----------------------------------------
    faculty_ids_in_sections = {s.get("faculty_id") for s in baseline_sections if s.get("faculty_id")}
    fac_state: Dict[str, Dict[str, Any]] = {}

    async def _build_fac_state(fid: str) -> Dict[str, Any]:
        on_leave = await is_on_approved_leave(db, fid, target_term["term_id"])

        active_hit_term: Optional[str] = None
        for t in active_terms:
            if await taught_in_term(db, fid, t):
                active_hit_term = t
                break
        is_active = active_hit_term is not None

        std_units = await faculty_capacity_units(db, fid, target_term["term_id"])
        deload = await get_deload_units(db, fid, target_term["term_id"])
        effective_units = max(0, int(std_units) - int(deload))
        now_sections_cap = (effective_units // ups) if ups > 0 else 0

        name = await faculty_display_name(db, fid)

        return {
            "faculty_id": fid,
            "name": name,
            "on_leave": bool(on_leave),
            "is_active": bool(is_active),
            "active_hit_term_id": active_hit_term,
            "capacity_units": int(std_units),
            "deload_units": int(deload),
            "effective_units": int(effective_units),
            "now_sections_capacity": int(now_sections_cap),
        }

    for fid in faculty_ids_in_sections:
        fac_state[fid] = await _build_fac_state(fid)

    # Ensure latest FT pool ids exist in state (defensive)
    for fid in (latest_ft_pool_ids or []):
        if fid and fid not in fac_state:
            fac_state[fid] = await _build_fac_state(fid)

    # -----------------------------------------
    # Allocate FT pool capacity across ALL baseline sections
    # (This prevents "PT last AY" from automatically creating uncovered sections.)
    #
    # Rule:
    # - Prefer the baseline FT instructor for their own FT sections when possible.
    # - Otherwise assign another available baseline FT with remaining capacity.
    # -----------------------------------------
    def _is_ft_available(fid: str) -> bool:
        st = fac_state.get(fid) or {}
        return (
            bool(fid)
            and (not st.get("on_leave"))
            and bool(st.get("is_active"))
            and int(st.get("now_sections_capacity") or 0) > 0
            and int(st.get("effective_units") or 0) >= int(ups or 0)
        )

    remaining_pool_cap: Dict[str, int] = {}
    for fid in (latest_ft_pool_ids or []):
        if _is_ft_available(fid):
            remaining_pool_cap[fid] = int(fac_state.get(fid, {}).get("now_sections_capacity") or 0)
        else:
            remaining_pool_cap[fid] = 0

    def _pick_best_ft(exclude: Optional[str] = None) -> Optional[str]:
        cands = [
            fid
            for fid, cap in remaining_pool_cap.items()
            if cap > 0 and fid and (exclude is None or fid != exclude)
        ]
        if not cands:
            return None
        # pick most remaining capacity (stable by id as tiebreaker)
        cands.sort(key=lambda f: (int(remaining_pool_cap.get(f, 0)), str(f)), reverse=True)
        return cands[0]

    section_breakdown: List[Dict[str, Any]] = []
    coverable_sections_now = 0

    # Keep latest FT pool candidates for UI (faculty-level)
    cap_detail: List[Dict[str, Any]] = []
    used_for_cap_detail: set[str] = set()
    for fid in (latest_ft_pool_ids or []):
        if not fid or fid in used_for_cap_detail:
            continue
        used_for_cap_detail.add(fid)
        st = fac_state.get(fid) or {}
        cap_detail.append(
            {
                "faculty_id": fid,
                "name": st.get("name") or await faculty_display_name(db, fid),
                "standard_units": int(st.get("capacity_units") or 0),
                "deload_units": int(st.get("deload_units") or 0),
                "effective_units": int(st.get("effective_units") or 0),
                "now_sections_capacity": int(st.get("now_sections_capacity") or 0),
                "baseline_sections_for_course": int(baseline_ft_sections_by_faculty.get(fid, 0)),
                "sections_can_cover": None,
            }
        )

    # Assign coverage per section
    for s in baseline_sections:
        sid = s.get("section_id")
        scode = s.get("section_code") or sid
        baseline_fid = s.get("faculty_id")
        et = (s.get("employment_type") or "").upper() if s.get("employment_type") else ""

        reasons: List[str] = []
        if not baseline_fid:
            reasons.append("NO_BASELINE_FACULTY_ASSIGNMENT")
        if et == "PT":
            reasons.append("BASELINE_TAUGHT_BY_PT")

        baseline_state = fac_state.get(baseline_fid) if baseline_fid else None
        if baseline_state:
            if baseline_state.get("on_leave"):
                reasons.append("ON_APPROVED_LEAVE")
            if not baseline_state.get("is_active"):
                reasons.append("INACTIVE_RECENT_TERMS")
            if ups > 0 and int(baseline_state.get("effective_units") or 0) < ups:
                reasons.append("INSUFFICIENT_UNITS_FOR_1_SECTION")
            if int(baseline_state.get("deload_units") or 0) > 0:
                reasons.append("DELOAD_APPLIED")

        covered_by: Optional[str] = None

        # Prefer baseline FT for FT baseline sections
        if et == "FT" and baseline_fid and remaining_pool_cap.get(baseline_fid, 0) > 0 and _is_ft_available(baseline_fid):
            covered_by = baseline_fid
        else:
            # Otherwise, use any other available baseline FT
            covered_by = _pick_best_ft(exclude=baseline_fid if et == "FT" else None)

        if covered_by:
            remaining_pool_cap[covered_by] = int(remaining_pool_cap.get(covered_by, 0)) - 1
            coverable_sections_now += 1

            if et == "PT":
                reasons.append("COVERED_BY_FT_POOL")
            elif et == "FT" and baseline_fid and covered_by != baseline_fid:
                reasons.append("COVERED_BY_OTHER_FT")

        status = "AVAILABLE" if covered_by else "UNAVAILABLE"

        # baseline display name (what happened last AY)
        baseline_name = None
        if baseline_fid:
            baseline_name = (fac_state.get(baseline_fid) or {}).get("name") or await faculty_display_name(db, baseline_fid)

        covered_by_name = None
        if covered_by:
            covered_by_name = (fac_state.get(covered_by) or {}).get("name") or await faculty_display_name(db, covered_by)

        section_breakdown.append(
            {
                "section_id": sid,
                "section_code": scode,
                "faculty_id": baseline_fid,
                "faculty_name": baseline_name,
                "baseline_employment_type": et or None,
                "status": status,
                "reasons": reasons,
                "active_check_terms": active_terms,
                "active_hit_term_id": (baseline_state or {}).get("active_hit_term_id") if baseline_state else None,
                "is_active": bool((baseline_state or {}).get("is_active")) if baseline_state else None,
                "on_leave": bool((baseline_state or {}).get("on_leave")) if baseline_state else None,
                "capacity_units": int((baseline_state or {}).get("capacity_units") or 0) if baseline_state else None,
                "deload_units": int((baseline_state or {}).get("deload_units") or 0) if baseline_state else None,
                "effective_units": int((baseline_state or {}).get("effective_units") or 0) if baseline_state else None,
                "now_sections_capacity": int((baseline_state or {}).get("now_sections_capacity") or 0) if baseline_state else None,
                "baseline_sections_for_course": int(baseline_ft_sections_by_faculty.get(baseline_fid, 0)) if baseline_fid else 0,
                "sections_can_cover": 1 if covered_by else 0,
                "covered_by_faculty_id": covered_by,
                "covered_by_name": covered_by_name,
            }
        )

    # demand = number of baseline sections for this course
    coverable = min(int(baseline_demand), int(coverable_sections_now))
    uncovered = max(0, int(baseline_demand) - int(coverable))

    # -----------------------------
    # Suggested Action
    # -----------------------------
    suggested_action: Optional[Dict[str, Any]] = None

    if uncovered > 0:
        # 1) Hire PT (need = uncovered)
        pt_needed = int(uncovered)

        pt_map: Dict[str, Dict[str, Any]] = {}
        ft_map: Dict[str, Dict[str, Any]] = {}

        for b in section_breakdown:
            et2 = (b.get("baseline_employment_type") or "").upper()
            fid2 = (b.get("faculty_id") or "").strip()
            name2 = (b.get("faculty_name") or "").strip() or fid2
            if not fid2:
                continue

            if et2 == "PT":
                cur = pt_map.get(fid2)
                if not cur:
                    pt_map[fid2] = {"faculty_id": fid2, "name": name2, "sections": 1}
                else:
                    cur["sections"] += 1

            if et2 == "FT":
                cur = ft_map.get(fid2)
                if not cur:
                    ft_map[fid2] = {
                        "faculty_id": fid2,
                        "name": name2,
                        "baseline_sections": int(b.get("baseline_sections_for_course") or 0) or 1,
                        "now_sections_capacity": int(b.get("now_sections_capacity") or 0),
                        "is_active": bool(b.get("is_active")),
                        "on_leave": bool(b.get("on_leave")),
                    }
                else:
                    cur["baseline_sections"] = max(
                        int(cur["baseline_sections"]),
                        int(b.get("baseline_sections_for_course") or 0) or 1,
                    )
                    cur["now_sections_capacity"] = max(
                        int(cur["now_sections_capacity"]),
                        int(b.get("now_sections_capacity") or 0),
                    )
                    cur["is_active"] = cur["is_active"] or bool(b.get("is_active"))
                    cur["on_leave"] = cur["on_leave"] or bool(b.get("on_leave"))

        pt_taught_last_year = sorted(
            pt_map.values(),
            key=lambda x: int(x.get("sections") or 0),
            reverse=True,
        )

        overload_candidates = sorted(
            [x for x in ft_map.values() if x.get("is_active") and not x.get("on_leave")],
            key=lambda x: (
                int(x.get("baseline_sections") or 0),
                int(x.get("now_sections_capacity") or 0),
            ),
            reverse=True,
        )[:5]

        suggested_action = {
            "pt_needed": pt_needed,
            "pt_taught_last_year": pt_taught_last_year,
            "overload_candidates": overload_candidates,
        }

    # Flags
    flags: List[str] = []
    if relied_on_pt_last_year:
        flags.append("This course relied on part-time faculty last year")
    if len(latest_ft_pool_ids) == 0:
        flags.append("No full-time faculty found in the recent teaching window")

    available_ft_ids: List[str] = []
    blocked_ft_ids: List[str] = []
    unknown_ft_ids: List[str] = []

    for fid in (latest_ft_pool_ids or []):
        st = fac_state.get(fid) or {}
        is_available = _is_ft_available(fid)
        is_blocked = bool(st.get("on_leave")) or (not bool(st.get("is_active"))) or int(st.get("effective_units") or 0) < int(ups or 0) or int(st.get("now_sections_capacity") or 0) <= 0
        if is_available:
            available_ft_ids.append(fid)
        elif is_blocked:
            blocked_ft_ids.append(fid)
        else:
            unknown_ft_ids.append(fid)

    if blocked_ft_ids:
        flags.append("Some faculty in the full-time pool are currently unable to teach")
    if unknown_ft_ids:
        flags.append("Some faculty in the full-time pool still need follow-up")
    if uncovered > 0 and baseline_demand > 0:
        flags.append("Current full-time pool cannot fully cover expected sections")

    # Risk classification
    reason_bucket: List[str] = []
    if baseline_demand <= 0:
        risk: RiskLevel = "SAFE"
    else:
        has_ft_pool = len(latest_ft_pool_ids) > 0
        has_pt_history = bool(relied_on_pt_last_year)

        if not has_ft_pool:
            risk = "RISK"
            reason_bucket.append("No full-time faculty found in the recent teaching window")
        elif blocked_ft_ids:
            risk = "RISK"
            reason_bucket.append("At least one faculty in the full-time pool is currently unable to teach")
        elif has_pt_history and available_ft_ids:
            risk = "WARNING"
            reason_bucket.append("The course relied on part-time faculty last year, but the current full-time pool appears available")
        elif available_ft_ids and uncovered > 0:
            risk = "WARNING"
            reason_bucket.append("The current full-time pool exists, but it does not fully cover expected sections yet")
        elif available_ft_ids:
            risk = "SAFE"
            reason_bucket.append("The current full-time pool appears available to cover this course")
        else:
            risk = "WARNING"
            reason_bucket.append("The course has a recent full-time teaching pool, but availability still needs follow-up")

    reason_bucket = reason_bucket[:3]

    # Suggestions
    ft_suggestions: List[Dict[str, Any]] = cap_detail[:suggest_top_n]

    # PT Suggestions (PT in dept, not on leave)
    pt_suggestions: List[Dict[str, Any]] = []
    async for fp in db[COL_FACULTY].find(
        {"$or": [{"department_id": dept_id}, {"dept_id": dept_id}], "employment_type": "PT"},
        projection={"faculty_id": 1},
    ):
        pfid = fp.get("faculty_id")
        if not pfid:
            continue
        if await is_on_approved_leave(db, pfid, target_term["term_id"]):
            continue
        pt_suggestions.append({"faculty_id": pfid, "name": await faculty_display_name(db, pfid)})
        if len(pt_suggestions) >= suggest_top_n:
            break

    # Confidence (simple heuristic)
    if baseline_demand > 0 and len(latest_ft_pool_ids) > 0:
        confidence = 100
    elif baseline_demand > 0:
        confidence = 70
    else:
        confidence = 50

    return {
        "course_id": course_id,
        "course": f"{course_code}".strip(),
        "course_title": (course_title or "").strip(),
        "baseline_demand_sections": int(baseline_demand),
        "ft_can_cover_sections_est": int(coverable),
        "risk": risk,
        "uncovered_sections": int(uncovered),
        "flags": flags,
        "reasons": reason_bucket,
        "ft_candidates": ft_suggestions,
        "pt_suggestions": pt_suggestions,
        "history": {
            "baseline_term_id": baseline_term["term_id"],
            "baseline_relay_on_pt": bool(relied_on_pt_last_year),
            "baseline_needed_overload": bool(uncovered > 0),
            "latest_offered_term_id": latest_offered_term_id,
            "full_time_faculty_pool": latest_ft_pool_names,
            "full_time_faculty_pool_ids": latest_ft_pool_ids,
            "full_time_faculty_pool_timeline": pool_timeline,
        },
        "ft_breakdown": section_breakdown,
        "confidence": int(confidence),
        "suggested_action": suggested_action,
    }

async def run_ft_coverage_review(params: Dict[str, Any]) -> Dict[str, Any]:
    db = get_db()
    P = {**DEFAULT_PARAMS, **(params or {})}

    tgt = None
    if P.get("target_term_id"):
        tgt = await db[COL_TERMS].find_one({"term_id": P["target_term_id"]})
    if not tgt:
        tgt = await next_term(db)
    if not tgt:
        raise RuntimeError("No next term found (check terms ordering / is_current).")

    baseline = await resolve_baseline_term(db, tgt)
    if not baseline:
        raise RuntimeError("Baseline term not found (same term_number, previous acad_year_start).")

    dept_id = P["DEPT_SCOPE"]

    dept = await db[COL_DEPARTMENTS].find_one(
        {"$or": [{"department_id": dept_id}, {"dept_id": dept_id}, {"id": dept_id}]},
        projection={"dept_name": 1, "department_name": 1},
    )
    dept_name = (dept or {}).get("dept_name") or (dept or {}).get("department_name") or dept_id

    baseline_map = await build_baseline_course_map(db, dept_id=dept_id, baseline_term_id=baseline["term_id"])
    recent_pool_map = await build_recent_ft_pool_map(
        db,
        dept_id=dept_id,
        baseline_term_id=baseline["term_id"],
        target_term_id=tgt["term_id"],
    )

    rows: List[Dict[str, Any]] = []
    async for c in db[COL_COURSES].find(
        {"$or": [{"department_id": dept_id}, {"dept_id": dept_id}]},
        projection={"course_id": 1, "course_code": 1, "course_title": 1},
    ):
        cid = c.get("course_id")
        if not cid:
            continue

        bc = baseline_map.get(cid) or {
            "demand_sections": 0,
            "baseline_ft_faculty_ids": set(),
            "baseline_ft_sections_by_faculty": {},
            "baseline_sections": [],
            "relied_on_pt_last_year": False,
        }
        demand = int(bc.get("demand_sections") or 0)
        ft_ids = list(bc.get("baseline_ft_faculty_ids") or [])
        relied_pt = bool(bc.get("relied_on_pt_last_year") or False)

        baseline_sections_map = bc.get("baseline_ft_sections_by_faculty") or {}
        baseline_sections_list = bc.get("baseline_sections") or []

        raw_code = c.get("course_code") or cid
        if isinstance(raw_code, list):
            course_code = raw_code[0] if raw_code else cid
        else:
            course_code = raw_code

        recent_pool = recent_pool_map.get(cid) or {}

        row = await compute_course_row(
            db=db,
            dept_id=dept_id,
            course_id=cid,
            course_code=str(course_code),
            course_title=str(c.get("course_title") or ""),
            baseline_demand=demand,
            baseline_ft_ids=ft_ids,
            latest_ft_pool_ids=list(recent_pool.get("latest_ft_pool_ids") or []),
            latest_ft_pool_names=list(recent_pool.get("latest_ft_pool") or []),
            pool_timeline=list(recent_pool.get("pool_timeline") or []),
            latest_offered_term_id=recent_pool.get("latest_offered_term_id"),
            relied_on_pt_last_year=relied_pt,
            baseline_term=baseline,
            target_term=tgt,
            suggest_top_n=int(P.get("suggest_top_n") or 3),
            baseline_ft_sections_by_faculty=baseline_sections_map,
            baseline_sections=baseline_sections_list,
        )
        if row["baseline_demand_sections"] > 0:
            rows.append(row)

    risk_count = sum(1 for r in rows if r["risk"] == "RISK")
    warn_count = sum(1 for r in rows if r["risk"] == "WARNING")
    safe_count = sum(1 for r in rows if r["risk"] == "SAFE")

    # Summary metrics for UI (decision-friendly)
    total_baseline_sections = sum(int(r.get("baseline_demand_sections") or 0) for r in rows)
    total_coverable_sections = sum(int(r.get("ft_can_cover_sections_est") or 0) for r in rows)
    total_uncovered_sections = max(0, int(total_baseline_sections) - int(total_coverable_sections))
    overall_coverage_pct = (
        round(100 * total_coverable_sections / total_baseline_sections)
        if total_baseline_sections > 0
        else 0
    )

    # Keep avg_confidence for backward compatibility (older UI versions)
    avg_conf = round(sum(r["confidence"] for r in rows) / len(rows)) if rows else 0

    summary = {
        "risk": risk_count,
        "warning": warn_count,
        "safe": safe_count,
        "avg_confidence": int(avg_conf),
        "total_baseline_sections": int(total_baseline_sections),
        "total_coverable_sections": int(total_coverable_sections),
        "total_uncovered_sections": int(total_uncovered_sections),
        "overall_coverage_pct": int(overall_coverage_pct),
    }

    return {
        "department_id": dept_id,
        "dept_name": dept_name,
        "target": {
            "term_id": tgt["term_id"],
            "acad_year_start": tgt.get("acad_year_start"),
            "term_number": tgt.get("term_number"),
        },
        "baseline": {
            "term_id": baseline["term_id"],
            "acad_year_start": baseline.get("acad_year_start"),
            "term_number": baseline.get("term_number"),
        },
        "summary": summary,
        "rows": rows,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "params": P,
    }

# -----------------------------
# Endpoints
# -----------------------------
@router.get("/departments")
async def list_departments():
    db = get_db()
    items: list[dict[str, str]] = []

    async for dep in db[COL_DEPARTMENTS].find(
        {},
        projection={"department_id": 1, "dept_name": 1, "department_name": 1},
    ).sort("dept_name", 1):
        did = dep.get("department_id")
        name = dep.get("dept_name") or dep.get("department_name") or did
        if did:
            items.append({"department_id": did, "department_name": name})

    return {"departments": items}

@router.get("/ft-coverage-review")
async def ft_coverage_review_endpoint(
    department_id: str = Query("DEPT0001"),
    target_term_id: Optional[str] = Query(None, description="defaults to current term if omitted"),
    suggest_top_n: int = Query(3, ge=1, le=10),
):
    try:
        return await run_ft_coverage_review(
            {"DEPT_SCOPE": department_id, "target_term_id": target_term_id, "suggest_top_n": suggest_top_n}
        )
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))

__all__ = ["router"]