# analytics/app/OM_REPORTS_ANALYTICS/OM_RP_AvailabilityForecasting.py
from fastapi import APIRouter, Query
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
    course_id: Optional[str] = None,
    dept_id: Optional[str] = None,
    threshold: float = 0.50,
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
    db = get_db()

    cur = await _current_term(db)
    terms = await _ordered_terms(db)
    term_label_by_id = {t["term_id"]: _term_label(t) for t in terms if t.get("term_id")}
    if not cur:
        return {"warnings": ["No current term found."], "slots": {}, "total_faculty_considered": 0, "faculty_with_recent_pref": 0, "faculty_with_recent_history": 0, "most_supported_slot_count": 0}
    curr_term_id = cur.get("term_id")
    if not curr_term_id:
        return {"warnings": ["Current term is missing term_id."], "slots": {}, "total_faculty_considered": 0,
                "faculty_with_recent_pref": 0, "faculty_with_recent_history": 0, "most_supported_slot_count": 0}
    prev_term = curr_term_id  # use current term prefs (T) to forecast T+1
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

    # New Metrics
    total_faculty_considered: int = 0
    faculty_with_recent_pref: int = 0
    faculty_with_recent_history: int = 0
    
    # Pre-fetch history section IDs to make the history check efficient
    sec_ids_hist = []
    if hist_terms:
        sec_ids_hist = await db.sections.distinct("section_id", {"term_id": {"$in": hist_terms}})

    async for fp in db.faculty_profiles.find({}):
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
            continue
            
        pref_curr = await db.faculty_preferences.find_one(
            {"faculty_id": fid, "term_id": curr_term_id},
            projection={"preferred_units": 1}
        )
        if pref_curr and int(pref_curr.get("preferred_units", 0)) == 0:
            continue
            
        # Candidate if (prev-term pref) OR (has history in last 3 terms)
        has_prev_pref = await db.faculty_preferences.find_one(
            {"faculty_id": fid, "term_id": prev_term}, projection={"_id": 1}
        ) is not None
        
        has_history_any = False
        if sec_ids_hist:
            has_history_any = await db.faculty_assignments.find_one(
                {"faculty_id": fid, "section_id": {"$in": sec_ids_hist}}, projection={"_id": 1}
            ) is not None
            
        if not (has_prev_pref or has_history_any):
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
            {"faculty_id": fid, "term_id": prev_term},
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

        # Score & keep Top-N
        scored: List[Tuple[Tuple[str, str], float, str]] = []
        for key in freq.keys():
            f = freq.get(key, 0.0)
            preferred = key in pref_keys
            base = 0.30
            pref_boost = 0.20 if preferred else 0.0
            score = _clamp(base + pref_boost + _clamp(f, 0.0, 1.0) * 0.50, 0.0, 1.0)
            if f > 0 and preferred: reason = "Commonly taught in recent terms & preferred last term"
            elif f > 0:             reason = "Commonly taught in recent terms"
            elif preferred:         reason = "Preferred in previous term"
            else:                   reason = "Pattern signal"
            scored.append((key, score, reason))

        # Handle preference-only case (no history but previous preference exists)
        if not has_history_detailed and pref_keys:
            # Only add if the slot wasn't already scored with history (which is unlikely if has_history_detailed is false, but safe)
            existing_keys = {item[0] for item in scored}
            for key in pref_keys:
                if key not in existing_keys:
                    score = _clamp(0.30 + 0.20, 0.0, 1.0)  # preference-only
                    scored.append((key, score, "Preferred in previous term"))

        scored.sort(key=lambda x: x[1], reverse=True)
        topN = scored[:TOP_N_PER_FACULTY]

        notes = []
        if not pref_curr: notes.append("No current-term preference on record.")
        # Note: 'No leaves recorded for this term.' is implicit for considered faculty
        if has_prev_pref: notes.append("Candidate criterion: previous-term preference.")
        if has_history_any: notes.append("Candidate criterion: has assignment history in last 3 terms.")
        
        # Determine current faculty's top-N reason
        
        for (day, label), score, reason in topN:
            if score < threshold:
                continue
            grid[(day, label)]["count"] += 1
            grid[(day, label)]["list"].append({
                "faculty_id": fid,
                "name": name,
                "email": email,
                "confidence_pct": round(score * 100),
                "reason": reason,
                "notes": notes,
            })

    # Calculate Most Supported Slot Count
    most_supported_slot_count = 0
    for key in grid:
        most_supported_slot_count = max(most_supported_slot_count, grid[key]["count"])

    prev_label = term_label_by_id.get(prev_term, prev_term)
    hist_labels = [term_label_by_id.get(tid, tid) for tid in hist_terms]
    term_label = term_label_by_id.get(cur["term_id"], cur["term_id"])

    slots = { f"{d}|{s}": grid[(d, s)] for d in DAY_CODES for s in TIME_SLOTS }
    return {
        "term_id": cur["term_id"],
        "term_label": term_label,
        "previous_term_for_prefs": prev_term,
        "previous_term_for_prefs_label": prev_label,
        "history_terms": hist_terms,
        "history_terms_labels": hist_labels,
        "warnings": warnings,
        "total_faculty_considered": total_faculty_considered,
        "faculty_with_recent_pref": faculty_with_recent_pref,
        "faculty_with_recent_history": faculty_with_recent_history,
        "most_supported_slot_count": most_supported_slot_count,
        "slots": slots,
    }

# ------------------------------- Route -----------------------------------------
@router.get("/faculty-availability-heatmap")
async def faculty_availability_heatmap_endpoint(
    course_id: Optional[str] = Query(None),
    dept_id: Optional[str] = Query(None),
    threshold: float = Query(0.50),
):
    return await build_faculty_availability_heatmap(
        course_id=course_id, dept_id=dept_id, threshold=threshold
    )

# add this alias just under the existing endpoint
@router.get("/availability-forecast")
async def availability_forecast_alias(
    course_id: Optional[str] = Query(None),
    dept_id: Optional[str] = Query(None),
    threshold: float = Query(0.50),
):
    return await build_faculty_availability_heatmap(
        course_id=course_id, dept_id=dept_id, threshold=threshold
    )