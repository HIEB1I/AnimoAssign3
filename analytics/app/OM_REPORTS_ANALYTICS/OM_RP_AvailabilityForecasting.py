# analytics/app/OM_REPORTS_ANALYTICS/OM_RP_AvailabilityForecasting.py
from fastapi import APIRouter, Query, Depends
from typing import Any, Dict, List, Optional, Tuple

# Reuse the shared DB connection from db_async
from ..db_async import get_db  # central client/db glue

router = APIRouter(prefix="/analytics", tags=["Reports & Analytics"])

# ----------------------------- Helpers / Tunables -----------------------------
DAY_CODES: List[str] = ["M", "T", "W", "H", "F", "S"]
TIME_SLOTS: List[str] = [
    "07:30-09:00","09:15-10:45","11:00-12:30",
    "12:45-14:15","14:30-16:00","16:15-17:45",
    "18:00-19:30","19:45-21:15",
]
DAY_MAP = {
    "Mon": "M", "Monday": "M", "M": "M",
    "Tue": "T", "Tues": "T", "Tuesday": "T", "T": "T",
    "Wed": "W", "Wednesday": "W", "W": "W",
    "Thu": "H", "Thur": "H", "Thurs": "H", "Thursday": "H", "H": "H",
    "Fri": "F", "Friday": "F", "F": "F",
    "Sat": "S", "Saturday": "S", "S": "S",
}
TOP_N_PER_FACULTY = 5

def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))

def _to_minutes_any(s: str) -> int:
    v = str(s or "").strip()
    if not v:
        return 0
    if ":" in v:
        parts = v.split(":")
        hh = int(parts[0] or 0); mm = int(parts[1] or 0)
        return hh * 60 + mm
    v = v.zfill(4)
    hh, mm = int(v[:2]), int(v[2:])
    return hh * 60 + mm

def _range_to_minutes(rng: str) -> Tuple[int, int]:
    parts = [p.strip() for p in str(rng).split("-")]
    if len(parts) != 2:
        return (0, 0)
    return (_to_minutes_any(parts[0]), _to_minutes_any(parts[1]))

def _overlaps(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    return max(a_start, b_start) < min(a_end, b_end)

def _term_label(t: Dict[str, Any]) -> str:
    ay = int(t.get("acad_year_start") or 0)
    tn = int(t.get("term_number") or 0)
    if ay and tn:
        return f"A.Y. {ay}-{ay+1} Term {tn}"
    # fallback if fields missing
    return str(t.get("term_id") or "")

# Precompute canonical slot minute ranges
SLOT_RANGES: List[Tuple[int, int]] = []
for s in TIME_SLOTS:
    a, b = [x.strip() for x in s.split("-")]
    SLOT_RANGES.append((_to_minutes_any(a), _to_minutes_any(b)))

async def _current_term(db) -> Optional[Dict[str, Any]]:
    return await db.terms.find_one({"is_current": True})

async def _ordered_terms(db) -> List[Dict[str, Any]]:
    cur = db.terms.find({}).sort([("acad_year_start", 1), ("term_number", 1)])
    return [t async for t in cur]

async def _prev_n_terms(db, term_id: str, N: int) -> List[str]:
    terms = await _ordered_terms(db)
    ids = [t["term_id"] for t in terms]
    if term_id not in ids:
        return []
    i = ids.index(term_id)
    start = max(0, i - N)
    return ids[start:i][::-1]  # newest first

def _recency_weights(term_ids: List[str]) -> Dict[str, float]:
    if not term_ids:
        return {}
    w = [0.6, 0.3, 0.1][:len(term_ids)]
    newest_first = list(reversed(term_ids))
    return {newest_first[i]: w[i] for i in range(len(newest_first))}

# ------------------------ Core: availability heatmap --------------------------
async def build_faculty_availability_heatmap(
    db=Depends(get_db),
    course_id: Optional[str] = None,
    dept_id: Optional[str] = None,
    threshold: float = 0.50,
    term_id: Optional[str] = None,
    direction: str = "current",
    counting_mode: str = "top1",
) -> Dict[str, Any]:
    """
    Returns a “propensity-to-assign” heatmap keyed by "D|HH:MM-HH:MM".
    {
      term_id, previous_term_for_prefs, history_terms, warnings: [...],
      total_faculty_considered: n, faculty_with_recent_pref: n, faculty_with_recent_history: n,
      most_supported_slot_count: n,
      slots: {
        "M|07:30-09:00": {
          count: n,
          list: [{ faculty_id, name, email, confidence_pct, reason, notes: [...] }]
        },
        ...
      }
    }
    """
    # Resolve the anchor term (defaults to the system current term), and allow
    # simple Prev/Next navigation that mirrors other OM_RP tabs.
    terms = await _ordered_terms(db)
    if not terms:
        return {"warnings": ["No terms found."], "slots": {}, "total_faculty_considered": 0, "faculty_with_recent_pref": 0, "faculty_with_recent_history": 0, "most_supported_slot_count": 0}

    # Find the "current" term from DB for defaulting and active-tagging.
    cur_db = next((t for t in terms if t.get("is_current")), None)

    ids = [t.get("term_id") for t in terms if t.get("term_id")]
    anchor = term_id if term_id in ids else (cur_db.get("term_id") if cur_db else ids[-1])

    try:
        i = ids.index(anchor)
    except ValueError:
        i = max(0, len(ids) - 1)

    if direction == "prev" and i > 0:
        i -= 1
    elif direction == "next" and i < len(ids) - 1:
        i += 1
    # direction == "current" keeps i as-is

    cur = next((t for t in terms if t.get("term_id") == ids[i]), None)
    term_label_by_id = {t["term_id"]: _term_label(t) for t in terms if t.get("term_id")}
    if not cur:
        return {"warnings": ["No current term found."], "slots": {}, "total_faculty_considered": 0, "faculty_with_recent_pref": 0, "faculty_with_recent_history": 0, "most_supported_slot_count": 0}
    curr_term_id = cur.get("term_id")
    if not curr_term_id:
        return {"warnings": ["Current term is missing term_id."], "slots": {}, "total_faculty_considered": 0,
                "faculty_with_recent_pref": 0, "faculty_with_recent_history": 0, "most_supported_slot_count": 0}
    source_term_id = curr_term_id  # use current term prefs (T) to forecast T+1
    hist_terms = await _prev_n_terms(db, curr_term_id, 3)
    weights = _recency_weights(hist_terms)

    warnings: List[str] = []
    if await db.faculty_preferences.count_documents({"term_id": curr_term_id}) == 0:
        curr_label = term_label_by_id.get(curr_term_id, curr_term_id)
        warnings.append(
            f"Pre-survey mode: expecting current-term preferences ({curr_label}) for next-term forecast; "
            "none found yet. Using assignment history only."
        )

    # Build empty grid
    grid: Dict[Tuple[str, str], Dict[str, Any]] = {
        (d, s): {"count": 0, "list": []} for d in DAY_CODES for s in TIME_SLOTS
    }

    # Counting mode: keep the UI honest by letting it count either the single
    # strongest slot per faculty (Top 1) or a broader set (Top 5).
    cm = (counting_mode or "top1").strip().lower()
    top_n_per_faculty = 1 if cm in ("top1", "1", "one") else TOP_N_PER_FACULTY

    # New Metrics
    total_faculty_considered: int = 0
    faculty_with_recent_pref: int = 0
    faculty_with_recent_history: int = 0
    
    # Pre-fetch history section IDs to make the history check efficient
    sec_ids_hist = []
    if hist_terms:
        sec_ids_hist = await db.sections.distinct("section_id", {"term_id": {"$in": hist_terms}})

    active_term = await db.terms.find_one({"is_current": True}, {"_id": 0, "term_id": 1})
    if not active_term or not active_term.get("term_id"):
        return {
            "warnings": ["No active term found in terms (is_current=true)."],
            "slots": {},
            "total_faculty_considered": 0,
            "faculty_with_recent_pref": 0,
            "faculty_with_recent_history": 0,
            "most_supported_slot_count": 0,
        }

    curr_term_id = active_term["term_id"]
    source_term_id = curr_term_id

    # last 3 terms (relative to active term)
    hist_terms = await _prev_n_terms(db, curr_term_id, 3)
    weights = _recency_weights(hist_terms)

    # Faculty population (for inclusion/exclusion transparency)
    scope_query: Dict[str, Any] = {}
    if dept_id:
        scope_query["department_id"] = dept_id

    # Course scope is checked via faculty profile fields (same as below)
    scope_profiles = [
        fp async for fp in db.faculty_profiles.find(
            scope_query,
            {"faculty_id": 1, "department_id": 1, "qualified_kacs": 1, "course_ids": 1},
        )
    ]

    scope_fids: List[str] = []
    excluded_not_qualified = 0
    for fp in scope_profiles:
        fid = fp.get("faculty_id")
        if not fid:
            continue
        if course_id:
            kvals = set(fp.get("qualified_kacs", [])) | set(fp.get("course_ids", []))
            if course_id not in kvals:
                excluded_not_qualified += 1
                continue
        scope_fids.append(fid)

    faculty_total_in_scope = len(scope_fids)

    # only faculty who SUBMITTED preferences for the active term
    # (use is_finished if that’s your “submitted” flag; otherwise remove it)
    pref_fids = await db.faculty_preferences.distinct(
        "faculty_id",
        {"term_id": curr_term_id, "is_finished": True},
    )

    pref_fids_set = set(pref_fids or [])
    if not pref_fids_set:
        return {
            "warnings": [f"No submitted faculty preferences found for active term {curr_term_id}."],
            "slots": {},
            "total_faculty_considered": 0,
            "faculty_with_recent_pref": 0,
            "faculty_with_recent_history": 0,
            "most_supported_slot_count": 0,
        }

    # only faculty who TAUGHT in the latest past 3 terms
    sec_ids_hist = []
    if hist_terms:
        sec_ids_hist = await db.sections.distinct("section_id", {"term_id": {"$in": hist_terms}})

    hist_fids = set()
    if sec_ids_hist:
        hist_fids = set(await db.faculty_assignments.distinct("faculty_id", {"section_id": {"$in": sec_ids_hist}}))

    # final eligible pool = submitted prefs AND taught in last 3 terms
    eligible_fids = pref_fids_set.intersection(hist_fids)

    # Inclusion/exclusion breakdown (simple + transparent)
    excluded_no_submitted_prefs = 0
    excluded_no_recent_history = 0
    excluded_on_leave = 0
    excluded_preferred_units_zero = 0
    excluded_no_signal = 0

    # Compute exclusions relative to the scope pool when available; otherwise fall back
    # to a conservative approximation based on preference/history presence.
    base_pool = scope_fids if scope_fids else list(pref_fids_set.union(hist_fids))
    for fid in base_pool:
        if fid not in pref_fids_set:
            excluded_no_submitted_prefs += 1
            continue
        if fid not in hist_fids:
            excluded_no_recent_history += 1
            continue
    if not eligible_fids:
        return {
            "warnings": [f"No faculty matched: submitted prefs ({curr_term_id}) AND taught in last 3 terms."],
            "slots": {},
            "total_faculty_considered": 0,
            "faculty_with_recent_pref": 0,
            "faculty_with_recent_history": 0,
            "most_supported_slot_count": 0,
        }

    async for fp in db.faculty_profiles.find({"faculty_id": {"$in": list(eligible_fids)}}):
        if dept_id and fp.get("department_id") != dept_id:
            continue
        if course_id:
            kvals = set(fp.get("qualified_kacs", [])) | set(fp.get("course_ids", []))
            if course_id not in kvals:
                continue

        fid = fp["faculty_id"]

        # Exclude if on approved leave this term
        lv = await db.leaves.find_one({
            "faculty_id": fid, "approval_status": "APPROVED",
            "start_term_id": {"$lte": curr_term_id},
            "end_term_id":   {"$gte": curr_term_id},
        })
        if lv:
            excluded_on_leave += 1
            continue
            
        pref_curr = await db.faculty_preferences.find_one(
            {"faculty_id": fid, "term_id": curr_term_id},
            projection={"preferred_units": 1}
        )

        preferred_units = (pref_curr or {}).get("preferred_units") or 0
        if int(preferred_units) == 0:
            excluded_preferred_units_zero += 1
            continue
            
        # Candidate if (prev-term pref) OR (has history in last 3 terms)
        has_prev_pref = await db.faculty_preferences.find_one(
            {"faculty_id": fid, "term_id": source_term_id}, projection={"_id": 1}
        ) is not None
        
        has_history_any = False
        if sec_ids_hist:
            has_history_any = await db.faculty_assignments.find_one(
                {"faculty_id": fid, "section_id": {"$in": sec_ids_hist}}, projection={"_id": 1}
            ) is not None
            
        if not (has_prev_pref or has_history_any):
            excluded_no_signal += 1
            continue

        # Increment Quality Metrics (only if considered for scoring)
        total_faculty_considered += 1
        if has_prev_pref:
            faculty_with_recent_pref += 1
        if has_history_any:
            faculty_with_recent_history += 1


        # Display name/email
        u = await db.users.find_one({"user_id": fp.get("user_id")}, {"first_name": 1, "last_name": 1, "email": 1})
        if not u and fp.get("faculty_id"):
            u = await db.users.find_one({"user_id": fp.get("faculty_id")}, {"first_name": 1, "last_name": 1, "email": 1})
        name = f"{(u or {}).get('last_name','')}, {(u or {}).get('first_name','')}".strip(", ").strip() or fp.get("faculty_id")
        email = (u or {}).get("email")

        # History frequency (recency-weighted, counts multiplicity)
        freq: Dict[Tuple[str, str], float] = {(d, s): 0.0 for d in DAY_CODES for s in TIME_SLOTS}
        has_history_detailed = False
        if hist_terms:
            assigns = await db.faculty_assignments.find({"faculty_id": fid}).to_list(length=None)
            if assigns:
                section_ids = [a["section_id"] for a in assigns]
                sec_map: Dict[str, str] = {}
                async for sec in db.sections.find(
                    {"section_id": {"$in": section_ids}, "term_id": {"$in": hist_terms}},
                    {"section_id": 1, "term_id": 1}
                ):
                    sec_map[sec["section_id"]] = sec["term_id"]

                if sec_map:
                    has_history_detailed = True
                    async for sc in db.section_schedules.find({"section_id": {"$in": list(sec_map.keys())}}):
                        tid = sec_map.get(sc["section_id"])
                        if not tid or tid not in weights:
                            continue
                        d_raw = sc.get("day")
                        d = DAY_MAP.get(str(d_raw), d_raw)
                        if d not in DAY_CODES:
                            continue
                        st_min = _to_minutes_any(sc.get("start_time"))
                        et_min = _to_minutes_any(sc.get("end_time"))
                        if st_min >= et_min:
                            continue
                        w = weights[tid]
                        for idx, slot_label in enumerate(TIME_SLOTS):
                            slot_st, slot_et = SLOT_RANGES[idx]
                            if _overlaps(st_min, et_min, slot_st, slot_et):
                                freq[(d, slot_label)] += w

        # Preference reinforcement from previous term
        pref_keys: set = set()
        prev_doc = await db.faculty_preferences.find_one(
            {"faculty_id": fid, "term_id": source_term_id},
            projection={"availability_days": 1, "preferred_times": 1}
        )
        if prev_doc:
            days = [DAY_MAP.get(str(d), d) for d in (prev_doc.get("availability_days") or [])]
            for rng in (prev_doc.get("preferred_times") or []):
                st_min, et_min = _range_to_minutes(rng)
                if st_min >= et_min:
                    continue
                for idx, label in enumerate(TIME_SLOTS):
                    sst, setm = SLOT_RANGES[idx]
                    if _overlaps(st_min, et_min, sst, setm):
                        for d in days:
                            if d in DAY_CODES:
                                pref_keys.add((d, label))

        # Score & keep Top-N (now also keep f + preferred so we can show a breakdown)
        scored: List[Tuple[Tuple[str, str], float, str, float, bool]] = []
        for key in freq.keys():
            f = float(freq.get(key, 0.0))
            preferred = key in pref_keys

            base = 0.30
            pref_boost = 0.20 if preferred else 0.0
            history_signal = _clamp(f, 0.0, 1.0)
            history_boost = history_signal * 0.50

            score = _clamp(base + pref_boost + history_boost, 0.0, 1.0)

            if f > 0 and preferred: reason = "Commonly taught in recent terms & preferred last term"
            elif f > 0:             reason = "Commonly taught in recent terms"
            elif preferred:         reason = "Preferred in previous term"
            else:                   reason = "Pattern signal"

            scored.append((key, score, reason, f, preferred))

        # Handle preference-only case (no history but previous preference exists)
        if not has_history_detailed and pref_keys:
            existing_keys = {item[0] for item in scored}
            for key in pref_keys:
                if key not in existing_keys:
                    base = 0.30
                    pref_boost = 0.20
                    f = 0.0
                    preferred = True
                    history_signal = 0.0
                    history_boost = 0.0
                    score = _clamp(base + pref_boost, 0.0, 1.0)
                    scored.append((key, score, "Preferred in previous term", f, preferred))

        scored.sort(key=lambda x: x[1], reverse=True)
        topN = scored[:top_n_per_faculty]

        notes = []
        if not pref_curr:
            notes.append("No current-term preference on record.")
        if has_prev_pref:
            notes.append("Candidate criterion: previous-term preference.")
        if has_history_any:
            notes.append("Candidate criterion: has assignment history in last 3 terms.")

        for (day, label), score, reason, f, preferred in topN:
            if score < threshold:
                continue

            base = 0.30
            pref_boost = 0.20 if preferred else 0.0
            history_signal = _clamp(float(f), 0.0, 1.0)
            history_boost = history_signal * 0.50

            grid[(day, label)]["count"] += 1
            grid[(day, label)]["list"].append({
                "faculty_id": fid,
                "name": name,
                "email": email,
                "confidence_pct": round(score * 100),
                "reason": reason,
                "notes": notes,
                "score_breakdown": {
                    "base": round(base, 2),
                    "pref_boost": round(pref_boost, 2),
                    "history_signal": round(float(f), 2),      # raw f (may be >1)
                    "history_boost": round(history_boost, 2),  # clamped×0.50
                    "total": round(float(score), 2),
                },
            })

    # Calculate Most Supported Slot Count
    most_supported_slot_count = 0
    for key in grid:
        most_supported_slot_count = max(most_supported_slot_count, grid[key]["count"])

    prev_label = term_label_by_id.get(source_term_id, source_term_id)
    hist_labels = [term_label_by_id.get(tid, tid) for tid in hist_terms]
    term_label = term_label_by_id.get(cur["term_id"], cur["term_id"])

    slots = { f"{d}|{s}": grid[(d, s)] for d in DAY_CODES for s in TIME_SLOTS }

    # Decision-first summaries
    eligible_included = total_faculty_considered
    slot_items: List[Dict[str, Any]] = []
    for (d, s), cell in grid.items():
        c = int(cell.get("count") or 0)
        slot_items.append({
            "day": d,
            "slot": s,
            "key": f"{d}|{s}",
            "count": c,
            "ratio": (c / eligible_included) if eligible_included > 0 else 0.0,
        })
    slot_items_sorted = sorted(slot_items, key=lambda x: (x["count"], x["key"]), reverse=True)
    top_blocks = slot_items_sorted[:5]
    risk_blocks = sorted(slot_items, key=lambda x: (x["count"], x["key"]))[:5]

    # Coverage: % of included faculty that appear in at least one recommended block
    rec_faculty_ids: set = set()
    for b in top_blocks:
        cell = slots.get(b["key"], {})
        for p in (cell.get("list") or []):
            if p.get("faculty_id"):
                rec_faculty_ids.add(p["faculty_id"])
    coverage_pct = round((len(rec_faculty_ids) / eligible_included) * 100, 1) if eligible_included > 0 else 0.0

    excluded_breakdown = {
        "no_submitted_preferences": excluded_no_submitted_prefs,
        "no_recent_history": excluded_no_recent_history,
        "on_leave": excluded_on_leave,
        "preferred_units_zero": excluded_preferred_units_zero,
        "not_qualified": excluded_not_qualified,
        "no_signal": excluded_no_signal,
    }
    # Ensure the scope total is never missing/zero when we have included faculty.
    scope_total_safe = max(
        int(faculty_total_in_scope or 0),
        int(len(base_pool) if base_pool else 0),
        int(eligible_included or 0),
    )

    return {

        "term_id": cur["term_id"],
        "term_label": term_label,
        "previous_term_for_prefs": source_term_id,
        "previous_term_for_prefs_label": prev_label,
        "history_terms": hist_terms,
        "history_terms_labels": hist_labels,
        "warnings": warnings,
        "total_faculty_considered": total_faculty_considered,
        "faculty_with_recent_pref": faculty_with_recent_pref,
        "faculty_with_recent_history": faculty_with_recent_history,
        "most_supported_slot_count": most_supported_slot_count,
        "counting_mode": "top1" if top_n_per_faculty == 1 else "top5",
        "top_n_per_faculty": top_n_per_faculty,

        # Decision summary
        "eligible_faculty_included": eligible_included,
        "faculty_total_in_scope": scope_total_safe,
        "excluded_breakdown": excluded_breakdown,
        "coverage_pct": coverage_pct,
        "recommended_blocks": top_blocks,
        "risk_blocks": risk_blocks,
        # Term navigation helpers (used by the frontend Prev/Next buttons)
        "terms": [
            {
                "term_id": t.get("term_id"),
                "acad_year_start": int(t.get("acad_year_start") or 0),
                "term_number": int(t.get("term_number") or 0),
                "is_current": bool(t.get("is_current")),
            }
            for t in terms
            if t.get("term_id")
        ],
        "current_index": i,
        "has_prev": i > 0,
        "has_next": i < (len(ids) - 1),
        "term": {
            "term_id": cur.get("term_id"),
            "acad_year_start": int(cur.get("acad_year_start") or 0),
            "term_number": int(cur.get("term_number") or 0),
            "is_current": bool(cur.get("is_current")),
        },
        "slots": slots,
    }

# ------------------------------- Route -----------------------------------------
@router.get("/faculty-availability-heatmap")
async def faculty_availability_heatmap_endpoint(
    course_id: Optional[str] = Query(None),
    dept_id: Optional[str] = Query(None),
    threshold: float = Query(0.50),
    term_id: Optional[str] = Query(None),
    direction: str = Query("current"),
    counting_mode: str = Query("top1"),
    db=Depends(get_db),
):
    return await build_faculty_availability_heatmap(
        db=db,
        course_id=course_id,
        dept_id=dept_id,
        threshold=threshold,
        term_id=term_id,
        direction=direction,
        counting_mode=counting_mode,
    )

# add this alias just under the existing endpoint
@router.get("/availability-forecast")
async def availability_forecast_alias(
    course_id: Optional[str] = Query(None),
    dept_id: Optional[str] = Query(None),
    threshold: float = Query(0.50),
    term_id: Optional[str] = Query(None),
    direction: str = Query("current"),
    counting_mode: str = Query("top1"),
    db=Depends(get_db),
):
    return await build_faculty_availability_heatmap(
        db=db,
        course_id=course_id,
        dept_id=dept_id,
        threshold=threshold,
        term_id=term_id,
        direction=direction,
        counting_mode=counting_mode,
    )