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
    L = await db[COL_LEAVES].find_one({"faculty_id": faculty_id, "approval_status": "APPROVED"})
    if not L:
        return False
    st = L.get("start_term_id")
    en = L.get("end_term_id")
    if not st or not en:
        return False
    return await term_in_range(db, term_id, st, en)

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
    Use faculty_preferences.preferred_units for the target term.
    Fallback: faculty_profiles.min_units (FT=12, PT=0 in your DB).
    """
    pref = await db[COL_FACULTY_PREFS].find_one(
        {"faculty_id": faculty_id, "term_id": term_id},
        projection={"preferred_units": 1},
    )
    if pref and pref.get("preferred_units") is not None:
        try:
            return int(pref["preferred_units"])
        except Exception:
            pass

    fp = await db[COL_FACULTY].find_one({"faculty_id": faculty_id}, projection={"min_units": 1})
    return int((fp or {}).get("min_units") or 0)

async def faculty_employment_type(db: AsyncIOMotorDatabase, faculty_id: str) -> str:
    fp = await db[COL_FACULTY].find_one({"faculty_id": faculty_id}, projection={"employment_type": 1})
    return (fp.get("employment_type") or "").strip() if fp else ""

async def get_deload_units(db: AsyncIOMotorDatabase, faculty_id: str, term_id: str) -> int:
    """
    Best-effort deload lookup.
    - If you have a collection like 'deloadings' with {faculty_id, term_id, units}, we'll use it.
    - Otherwise returns 0 safely.
    """
    for col in ["deloadings", "deloading", "faculty_deloadings"]:
        try:
            doc = await db[col].find_one({"faculty_id": faculty_id, "term_id": term_id})
            if doc:
                units = doc.get("units") or doc.get("deload_units") or doc.get("deloading_units") or 0
                return int(units)
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

    # This guarantees: AD-FUND (demand=2) => exactly 2 breakdown rows (unless DB truly has more).
    baseline_sections = [s for s in baseline_sections if (s.get("course_id") == course_id)]
    # stable ordering (optional but helpful)
    baseline_sections.sort(key=lambda x: str(x.get("section_code") or x.get("section_id") or ""))

    # ---------------------------------------------------------
    # SECTION-LEVEL breakdown:
    # - One entry per baseline section (same term last AY)
    # - Includes section_code + faculty + name + employment_type
    # - Computes availability/reasons for that section's faculty now
    # - Allocates FT capacity across sections so sections_can_cover is 0/1 per section
    # ---------------------------------------------------------
    faculty_ids_in_sections = {s.get("faculty_id") for s in baseline_sections if s.get("faculty_id")}
    fac_state: Dict[str, Dict[str, Any]] = {}
    remaining_sections_cap: Dict[str, int] = {}

    for fid in faculty_ids_in_sections:
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

        fac_state[fid] = {
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
        remaining_sections_cap[fid] = int(now_sections_cap)

    section_breakdown: List[Dict[str, Any]] = []
    ft_coverable_sections = 0

    # keep suggestions (faculty-level) without changing your API shape
    cap_detail: List[Dict[str, Any]] = []
    used_for_cap_detail: set[str] = set()

    for s in baseline_sections:
        sid = s.get("section_id")
        scode = s.get("section_code") or sid
        fid = s.get("faculty_id")
        et = (s.get("employment_type") or "").upper() if s.get("employment_type") else ""

        if not fid:
            section_breakdown.append(
                {
                    "section_id": sid,
                    "section_code": scode,
                    "faculty_id": None,
                    "faculty_name": None,
                    "baseline_employment_type": None,
                    "status": "UNAVAILABLE",
                    "reasons": ["NO_BASELINE_FACULTY_ASSIGNMENT"],
                    "sections_can_cover": 0,
                }
            )
            continue

        st = fac_state.get(fid) or {}
        reasons: List[str] = []

        # baseline PT section: show it explicitly
        if et == "PT":
            reasons.append("BASELINE_TAUGHT_BY_PT")

        if st.get("on_leave"):
            reasons.append("ON_APPROVED_LEAVE")
        if not st.get("is_active"):
            reasons.append("INACTIVE_RECENT_TERMS")
        if ups > 0 and int(st.get("effective_units") or 0) < ups:
            reasons.append("INSUFFICIENT_UNITS_FOR_1_SECTION")
        if int(st.get("deload_units") or 0) > 0:
            reasons.append("DELOAD_APPLIED")

        can_cover_this_section = 0

        # only count FT coverage for sections that were FT last AY
        if et == "FT":
            if (not st.get("on_leave")) and st.get("is_active") and (remaining_sections_cap.get(fid, 0) > 0):
                can_cover_this_section = 1
                remaining_sections_cap[fid] = int(remaining_sections_cap.get(fid, 0)) - 1
                ft_coverable_sections += 1

        status = "AVAILABLE" if can_cover_this_section == 1 else "UNAVAILABLE"

        section_breakdown.append(
            {
                "section_id": sid,
                "section_code": scode,
                "faculty_id": fid,
                "faculty_name": st.get("name") or await faculty_display_name(db, fid),
                "baseline_employment_type": et or None,
                "status": status,
                "reasons": reasons,
                "active_check_terms": active_terms,
                "active_hit_term_id": st.get("active_hit_term_id"),
                "is_active": bool(st.get("is_active")),
                "on_leave": bool(st.get("on_leave")),
                "capacity_units": int(st.get("capacity_units") or 0),
                "deload_units": int(st.get("deload_units") or 0),
                "effective_units": int(st.get("effective_units") or 0),
                "now_sections_capacity": int(st.get("now_sections_capacity") or 0),
                "baseline_sections_for_course": int(baseline_ft_sections_by_faculty.get(fid, 0)),
                "sections_can_cover": int(can_cover_this_section),  # 0/1 per section
            }
        )

        # suggestions: keep baseline FT (faculty-level)
        if et == "FT" and fid in baseline_ft_ids and fid not in used_for_cap_detail:
            used_for_cap_detail.add(fid)
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

    # demand = number of baseline sections for this course
    ft_can_cover = min(int(baseline_demand), int(ft_coverable_sections))
    uncovered = max(0, int(baseline_demand) - int(ft_can_cover))

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
            et = (b.get("baseline_employment_type") or "").upper()
            fid = (b.get("faculty_id") or "").strip()
            name = (b.get("faculty_name") or "").strip() or fid
            if not fid:
                continue

            if et == "PT":
                cur = pt_map.get(fid)
                if not cur:
                    pt_map[fid] = {"faculty_id": fid, "name": name, "sections": 1}
                else:
                    cur["sections"] += 1

            if et == "FT":
                cur = ft_map.get(fid)
                if not cur:
                    ft_map[fid] = {
                        "faculty_id": fid,
                        "name": name,
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
    if len(baseline_ft_ids) <= 2 and baseline_demand > 0:
        flags.append("Only 1–2 FT instructors covered this course last year")
    if uncovered > 0 and baseline_demand > 0:
        flags.append("Some baseline sections are not coverable by baseline FT availability/capacity now")

    # Risk classification
    reason_bucket: List[str] = []
    if baseline_demand <= 0:
        risk: RiskLevel = "SAFE"
    else:
        if len(baseline_ft_ids) == 0:
            risk = "RISK"
            reason_bucket.append("No baseline FT teaching history last year")
        elif relied_on_pt_last_year:
            risk = "RISK"
            reason_bucket.append("PT covered at least 1 section last year")
        elif uncovered > 0:
            risk = "RISK"
            reason_bucket.append("Baseline sections become uncovered with baseline FT availability/capacity now")
        else:
            risk = "SAFE"

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

    # Confidence
    if baseline_demand > 0 and len(baseline_ft_ids) > 0:
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
        "ft_can_cover_sections_est": int(ft_can_cover),
        "risk": risk,
        "uncovered_sections": int(uncovered),
        "flags": flags,
        "reasons": reason_bucket,
        "ft_candidates": ft_suggestions,
        "pt_suggestions": pt_suggestions,
        "history": {
            "baseline_term_id": baseline_term["term_id"],
            "baseline_relay_on_pt": bool(relied_on_pt_last_year),
            "baseline_needed_overload": False,
        },
        # IMPORTANT: now BY SECTION (length should match baseline_demand if DB is consistent)
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

        row = await compute_course_row(
            db=db,
            dept_id=dept_id,
            course_id=cid,
            course_code=str(course_code),
            course_title=str(c.get("course_title") or ""),
            baseline_demand=demand,
            baseline_ft_ids=ft_ids,
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

    avg_conf = round(sum(r["confidence"] for r in rows) / len(rows)) if rows else 0

    summary = {
        "risk": risk_count,
        "warning": warn_count,
        "safe": safe_count,
        "avg_confidence": int(avg_conf),
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