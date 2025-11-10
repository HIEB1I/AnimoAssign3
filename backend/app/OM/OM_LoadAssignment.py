from __future__ import annotations
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Literal, Optional, Tuple

from fastapi import APIRouter, Body, HTTPException, Query, Depends
from pymongo import ReturnDocument

from dataclasses import dataclass
import math
from dataclasses import dataclass, asdict
from datetime import datetime, time
from functools import lru_cache
from motor.motor_asyncio import AsyncIOMotorClient

from ..main import db

import re 

def get_db():
    return db

COL_USERS = "users"
COL_STAFF = "staff_profiles"
COL_FACULTY = "faculty_profiles"
COL_ASSIGN = "faculty_assignments"
COL_SECTIONS = "sections"
COL_SCHED = "section_schedules"
COL_ROOMS = "rooms"
COL_COURSES = "courses"
COL_TERMS = "terms"
COL_DEPTS = "departments"
COL_CAMPUSES = "campuses"

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)

async def _active_term() -> Dict[str, Any]:
    # 1) find the current anchor (must be is_current=True)
    cur = await db[COL_TERMS].find_one(
        {"is_current": True},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )
    if not cur:
        return {}

    # 2) get the next term in chronological order
    nxt = await db[COL_TERMS].find(
        {
            "$or": [
                {"acad_year_start": {"$gt": cur["acad_year_start"]}},
                {
                    "acad_year_start": cur["acad_year_start"],
                    "term_number": {"$gt": cur["term_number"]},
                },
            ]
        },
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    ).sort([("acad_year_start", 1), ("term_number", 1)]).to_list(1)

    return (nxt[0] if nxt else {})

def _fmt_time(hhmm: Optional[Any]) -> str:
    """
    Return a string time in HH:MM. Accepts:
      - "07:30" (kept as-is)
      - "730"  or "0730" (normalized to "07:30")
      - numeric 730 (normalized to "07:30")
    Blanks/invalid -> "".
    """
    if hhmm in (None, "", 0):
        return ""

    s = str(hhmm).strip()

    # Already proper "HH:MM" → keep it
    if re.fullmatch(r"\d{1,2}:\d{2}", s):
        return s

    # Remove non-digits and normalize
    digits = re.sub(r"\D", "", s)
    if len(digits) == 3:
        digits = "0" + digits
    if len(digits) == 4:
        return f"{digits[:2]}:{digits[2:]}"

    # Anything else invalid
    return ""

async def _fetch_rows(user_id: str, term_id: str, db) -> Dict[str, Any]:
    active = await _active_term()
    term_id_active = active.get("term_id")

    pipe: List[Dict[str, Any]] = [
        {"$match": {"term_id": term_id_active}} if term_id_active else {"$match": {}},

        # base = sections ✅
        {"$lookup": {"from": COL_COURSES, "localField": "course_id", "foreignField": "course_id", "as": "course"}},
        {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},

        {"$lookup": {"from": COL_SCHED, "localField": "section_id", "foreignField": "section_id", "as": "scheds"}},

        # optional current assignment (0..1)
        {"$lookup": {"from": COL_ASSIGN, "localField": "section_id", "foreignField": "section_id", "as": "asg"}},
        {"$unwind": {"path": "$asg", "preserveNullAndEmptyArrays": True}},

        # join faculty + user to display name
        {"$lookup": {"from": COL_FACULTY, "localField": "asg.faculty_id", "foreignField": "faculty_id", "as": "fac"}},
        {"$unwind": {"path": "$fac", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": COL_USERS, "localField": "fac.user_id", "foreignField": "user_id", "as": "u"}},
        {"$unwind": {"path": "$u", "preserveNullAndEmptyArrays": True}},

        # normalize course_code (array|string → string)
        {"$addFields": {
            "course_code_display": {
                "$cond": [
                    {"$isArray": "$course.course_code"},
                    {"$ifNull": [{"$arrayElemAt": ["$course.course_code", 0]}, ""]},
                    {"$ifNull": ["$course.course_code", ""]},
                ]
            },
            "faculty_name_display": {
                "$trim": {"input": {"$concat": [
                    {"$ifNull": ["$u.last_name", ""]},
                    {"$cond": [{"$and":[{"$ne":["$u.last_name", None]},{"$ne":["$u.first_name", None]}]}, ", ", ""]},
                    {"$ifNull": ["$u.first_name", ""]},
                ]}}
            },
        }},
        {"$sort": {"course_code": 1}},
    ]

    docs = [x async for x in db[COL_SECTIONS].aggregate(pipe)]

    def schedule_pair(scheds: List[Dict[str, Any]]) -> Dict[str, str]:
        s1 = (scheds[0] if len(scheds) > 0 else {}) or {}
        s2 = (scheds[1] if len(scheds) > 1 else {}) or {}
        def room_label(s: Dict[str, Any]) -> str:
            t = (s.get("room_type") or "").strip()
            if t in ("Online", "TBA"): return t
            return s.get("room_id") or ""
        return {
            "day1": s1.get("day","") or "",
            "begin1": _fmt_time(s1.get("start_time")) or "",
            "end1": _fmt_time(s1.get("end_time")) or "",
            "room1": room_label(s1),
            "day2": s2.get("day","") or "",
            "begin2": _fmt_time(s2.get("start_time")) or "",
            "end2": _fmt_time(s2.get("end_time")) or "",
            "room2": room_label(s2),
        }

    rows: List[Dict[str, Any]] = []
    for d in docs:
        pair = schedule_pair(d.get("scheds") or [])
        rows.append({
            "id": d.get("section_id") or "",
            "course": d.get("course_code_display") or "",
            "title": (d.get("course") or {}).get("course_title","") or "",
            "units": (d.get("course") or {}).get("units","") or "",
            "section": d.get("section_code","") or "",
            "faculty": d.get("faculty_name_display","") or "",
            **pair,
            "capacity": d.get("enrollment_cap","") or "",
            "status": "Pending" if (d.get("asg") or {}).get("faculty_id") else "Unassigned",
        })

    term_label = (f"AY {active.get('acad_year_start')}-{(active.get('acad_year_start') or 0)+1} "
                  f"T{active.get('term_number')}") if active else ""
    return {"term": term_label, "rows": rows}

router = APIRouter(prefix="/om", tags=["om"])

@router.post("/loadassignment")
async def loadassignment_handler(
    userId: str = Query(..., min_length=3),
    action: str = Query("fetch", description="fetch | options | profile | submit"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    if action == "fetch":
        data = await _fetch_rows(userId)
        return data

    if action == "options":
        # Keep minimal for now; extend dropdowns later if UI needs them
        depts = [d async for d in db[COL_DEPTS].find(
            {}, {"_id": 0, "department_id": 1, "department_name": 1, "dept_name": 1}
        )]
        return {
            "ok": True,
            "departments": [ (d.get("department_name") or d.get("dept_name") or "").strip() for d in depts if d ],
            "statuses": ["Confirmed", "Pending", "Unassigned", "Conflict"],
        }

    if action == "profile":
        staff = await db[COL_STAFF].find_one({"user_id": userId}, {"_id": 0, "staff_id": 1, "position_title": 1})
        return {"ok": bool(staff), **(staff or {})}

    if action == "submit":
        # Validate
        if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list):
            raise HTTPException(status_code=400, detail="Invalid payload; expected { rows: [...] }")

        # This is intentionally minimal: we don’t alter schema here.
        # In a real flow you might upsert assignments, set approvals, etc.
        # We return rows in a display-ready shape immediately (optimistic UI).
        submitted_rows = payload["rows"]
        # TODO: enforce active-term scope; map faculty display -> faculty_id, etc.
        return {"ok": True, "rows": submitted_rows}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")

# ------------------ Algorithm lives HERE ------------------
# Make sure the name matches what the route calls,
# and it’s defined ABOVE the route.
async def build_load_recommendations(
    db,
    *,
    term_id: str,
    department_id: str,
    only_section_ids: List[str] | None = None,
    respect_locks: bool = True,
) -> Dict[str, Any]:
    """
    Read sections/faculty/etc. from DB and fill faculty/day/time/room.
    Return {"rows": [...]} matching your frontend Row type.
    """
    # 1) fetch sections for term/department (optionally filter by only_section_ids)
    # 2) fetch faculty_profiles, faculty_preferences, rooms, constraints
    # 3) compute assignments + detect conflicts
    # 4) shape rows as the UI expects
    rows: List[Dict[str, Any]] = [
        # example shape; replace with real computed rows
        # {
        #   "id": "ASG0001", "course": "CCPROG1", "title": "...", "units": 3,
        #   "section": "S11", "faculty": "Last, First",
        #   "day1":"M","begin1":"07:30","end1":"09:00","room1":"CL-101",
        #   "day2":"H","begin2":"07:30","end2":"09:00","room2":"CL-101",
        #   "capacity": 40, "status":"Pending", "conflictNote":"", "editable": True
        # }
    ]
    return {"rows": rows}

# ----------------------------------------------------------
def _term_label(t: dict) -> str:
    if not t: return ""
    ay = t["acad_year_start"]; return f"AY {ay}-{ay+1} T{t['term_number']}"

@router.get("/load-assignment/list")
async def get_om_load_assignment_list(user_id: str, db=Depends(get_db)):
    active = await _active_term()  # <-- this IS the upcoming term now
    if not active:
        raise HTTPException(409, "No upcoming term found (is_current anchor missing?)")

    base = await _fetch_rows(user_id, term_id=active["term_id"], db=db)
    return {"term": _term_label(active), "rows": base["rows"]}

@router.post("/load-assignment/run")
async def run_auto_assignment(
    user_id: str = Query(..., alias="user_id"),
    department_id: str | None = Query(None),
    db = Depends(get_db),
):
    active = await _active_term()  # <-- upcoming term
    if not active:
        raise HTTPException(409, "No upcoming term found (is_current anchor missing?)")

    # ensure prefs exist for the upcoming term
    pref_cnt = await db["faculty_preferences"].count_documents(
        {"term_id": active["term_id"], "is_finished": True}
    )
    if pref_cnt == 0:
        raise HTTPException(
            409,
            f"No faculty preferences submitted yet for upcoming term {active['term_id']}. "
            "Auto-assign is disabled until submissions exist."
        )

    base = await _fetch_rows(user_id, term_id=active["term_id"], db=db)
    rows = [dict(r) for r in base["rows"]]

    sugg = await compute_load_recommendations(term_id=active["term_id"], db=db)
    debug = sugg.get("debug", {}) or {}

    if not sugg.get("assignments"):
        return {
            "term": _term_label(active),
            "rows": rows,
            "debug": {
                "course_order_len": len(sugg.get("courses_order", [])),
                "assignments_len": 0,
                **debug,
                "candidate_sizes": {
                    cid: len(info.get("candidates", []))
                    for cid, info in (sugg.get("by_course", {}) or {}).items()
                },
            },
        }

    suggestions = {s["section_id"]: s for s in sugg.get("assignments", [])}
    for r in rows:
        a = suggestions.get(r["id"])
        if not a:
            continue
        r["faculty"] = a.get("faculty", r["faculty"])
        r["day1"]    = a.get("day1", r["day1"]);   r["begin1"] = a.get("begin1", r["begin1"]); r["end1"] = a.get("end1", r["end1"]); r["room1"] = a.get("room1", r["room1"])
        r["day2"]    = a.get("day2", r["day2"]);   r["begin2"] = a.get("begin2", r["begin2"]); r["end2"] = a.get("end2", r["end2"]); r["room2"] = a.get("room2", r["room2"])
        r["status"]  = a.get("status", "Pending")

    # <-- include debug from compute_load_recommendations (Phase 6A adds phase6a_faculty_debug)
    return {"term": _term_label(active), "rows": rows, "debug": (sugg.get("debug") or {})}

#    =========================================================
#         ===============  LOAD RECO ===================
#    ========================================================= 

# ===============  TYPES  ======================
Campus = Literal["Manila", "Laguna", "Online"]
CourseType = Literal["Foundation", "Major", "SHS", "GS"]
Mode = Literal["HYB", "FOL", "ONSITE", "ONLINE"]

@dataclass
class Section:
    section_id: str
    course_id: str
    campus: Campus
    units: int
    schedule: List[Dict[str, Any]]  # [{day:int, start:"HH:MM", end:"HH:MM"}]
    mode: Mode

@dataclass
class CourseStat:
    course_id: str
    type: CourseType
    sections: int
    units: int
    per_campus: Dict[Campus, int]
    score: int

# ===============  MILESTONE A (Phases 0–2)  ===============
@dataclass
class ContextA:
    term_id: str
    sections: list[dict]
    courses: dict[str, dict]
    schedules_by_section: dict[str, list[dict]]
    faculty: list[dict]
    users_by_faculty: dict[str, dict]
    prefs_prev_term_id: str | None
    prefs_by_faculty: dict[str, dict]
    kac_helper: dict | None = None
    course_order: list[str] | None = None

async def phase0_load(term_id: str, db, department_id: str | None = None) -> ContextA:
    # ------------------------------
    # 0) Term-scoped Sections
    # ------------------------------
    q = {"term_id": term_id}
    if department_id:
        q["department_id"] = department_id

    sections = await db[COL_SECTIONS].find(
        q,
        {
            "_id": 0,
            "section_id": 1,
            "course_id": 1,
            "department_id": 1,
            "campus_id": 1,
            "units": 1,
            "mode": 1,
            # schedule fields (if denormalized on sections)
            "day1": 1, "begin1": 1, "end1": 1, "room1": 1,
            "day2": 1, "begin2": 1, "end2": 1, "room2": 1,
        },
    ).sort([("course_id", 1), ("section_id", 1)]).to_list(None)

    # Early return if no sections
    if not sections:
        return ContextA(
            term_id=term_id,
            sections=[],
            courses={},
            schedules_by_section={},
            faculty=[],
            users_by_faculty={},
            prefs_prev_term_id=term_id,     # kept name for compatibility; equal to term_id
            prefs_by_faculty={},
            kac_helper=None,
            course_order=None,
        )

    # ------------------------------
    # 1) Courses (normalize units & type)
    # ------------------------------
    course_rows = await db[COL_COURSES].find({}, {"_id": 0}).to_list(None)

    def _units(r: dict) -> int:
        v = r.get("units", r.get("units_per_section"))
        try:
            v = int(v)
        except Exception:
            v = 0
        return v if v and v > 0 else 3

    def _ctype(r: dict) -> str:
        t = (r.get("type_of_course") or r.get("type") or "Major")
        return t.strip() if isinstance(t, str) else "Major"

    courses = {
        c["course_id"]: {**c, "units": _units(c), "type": _ctype(c)}
        for c in course_rows
        if c.get("course_id")
    }

    # ------------------------------
    # 2) KACs (Knowledge Area Clusters)
    # ------------------------------
    kac_rows = await db["kacs"].find({}, {"_id": 0}).to_list(None)
    course_to_kacs: dict[str, set[str]] = {}
    for k in kac_rows:
        for cid in (k.get("course_list") or []):
            if cid:
                course_to_kacs.setdefault(cid, set()).add(k["kac_id"])
    ctx_kacs = {k["kac_id"]: k for k in kac_rows if k.get("kac_id")}

    # ------------------------------
    # 3) Schedules (normalized collection)
    # ------------------------------
    section_ids = [s["section_id"] for s in sections if s.get("section_id")]
    schedules_by_section: dict[str, list[dict]] = {}
    if section_ids:
        sched_rows = await db[COL_SCHED].find(
            {"section_id": {"$in": section_ids}},
            {"_id": 0}
        ).to_list(None)
        for s in sched_rows:
            sid = s.get("section_id")
            if sid:
                schedules_by_section.setdefault(sid, []).append(s)

    # ------------------------------
    # 4) Faculty & Names (bulk user lookup; filter archived)
    # ------------------------------
    f_query = {"is_archived": {"$ne": True}}
    if department_id:
        # Apply if your faculty docs carry department_id; safe to keep even if not present
        f_query["department_id"] = department_id

    faculty = await db[COL_FACULTY].find(
        f_query,
        {
            "_id": 0,
            "faculty_id": 1,
            "user_id": 1,
            "employment_type": 1,
            "remaining_units": 1,
            "preferred_campus_ids": 1,
            "preferred_mode": 1,
            "qualified_kacs": 1,
            "kac_ids": 1,
        },
    ).to_list(None)

    # Bulk resolve names to avoid N+1
    user_ids = [f.get("user_id") for f in faculty if f.get("user_id")]
    users_by_id: dict[str, dict] = {}
    if user_ids:
        user_docs = await db[COL_USERS].find(
            {"user_id": {"$in": user_ids}},
            {"_id": 0, "user_id": 1, "first_name": 1, "last_name": 1},
        ).to_list(None)
        users_by_id = {u["user_id"]: u for u in user_docs if u.get("user_id")}

    users_by_faculty: dict[str, dict] = {}
    for f in faculty:
        fid = f.get("faculty_id")
        if not fid:
            continue
        u = users_by_id.get(f.get("user_id") or "")
        users_by_faculty[fid] = (u or {})

    # ------------------------------
    # 5) Preferences (for THIS upcoming term_id)
    # ------------------------------
    pref_rows = await db["faculty_preferences"].find(
        {"term_id": term_id, "is_finished": True},
        {
            "_id": 0,
            "faculty_id": 1,
            "preferred_units": 1,
            "availability_days": 1,
            "preferred_times": 1,
            "preferred_kacs": 1,
            "campus_id": 1,
            "leave_data": 1,
        },
    ).to_list(None)
    prefs_by_faculty = {
        r["faculty_id"]: r for r in pref_rows if r.get("faculty_id")
    }

    # Keep historical field name but set to current term (since 'target = next' is already satisfied)
    prefs_prev_term_id = term_id

    # ------------------------------
    # 6) Teaching history (last N terms before `term_id`)
    # ------------------------------
    HISTORY_TERMS = 3
    all_terms = await db[COL_TERMS].find(
        {}, {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1}
    ).sort([("acad_year_start", 1), ("term_number", 1)]).to_list(None)

    wanted_term_ids: list[str] = []
    if all_terms:
        idx = next((i for i, t in enumerate(all_terms) if t.get("term_id") == term_id), None)
        if idx is not None:
            start = max(0, idx - HISTORY_TERMS)
            wanted_term_ids = [t["term_id"] for t in all_terms[start:idx]]

    history_map: dict[tuple[str, str], int] = {}
    if wanted_term_ids:
        fa_rows = await db[COL_ASSIGN].find(
            {"term_id": {"$in": wanted_term_ids}},
            {"_id": 0, "faculty_id": 1, "course_id": 1}
        ).to_list(None)
        for r in fa_rows:
            fid, cid = r.get("faculty_id"), r.get("course_id")
            if fid and cid:
                history_map[(fid, cid)] = history_map.get((fid, cid), 0) + 1

    hist_by_course: dict[str, int] = {}
    for (fid, cid), n in history_map.items():
        hist_by_course[cid] = hist_by_course.get(cid, 0) + n

    # ------------------------------
    # 7) Assemble Context
    # ------------------------------
    ctx = ContextA(
        term_id=term_id,
        sections=sections,
        courses=courses,
        schedules_by_section=schedules_by_section,
        faculty=faculty,
        users_by_faculty=users_by_faculty,
        prefs_prev_term_id=prefs_prev_term_id,   # kept for compatibility
        prefs_by_faculty=prefs_by_faculty,
        kac_helper=None,
        course_order=None,
    )
    # Attach extras (attrs referenced by later phases)
    ctx.hist_by_course = hist_by_course          # type: ignore[attr-defined]
    ctx.history_map = history_map                # type: ignore[attr-defined]
    ctx.kacs = ctx_kacs                          # type: ignore[attr-defined]
    ctx.course_to_kacs = course_to_kacs          # type: ignore[attr-defined]
    return ctx

def phase1_kac_helpers(ctx: ContextA, weights: dict[str, int] | None = None) -> None:
    if weights is None:
        weights = {"Foundation": 3, "Major": 1, "SHS": 1, "GS": 1}
    # minimal KAC-like stats (course-level)
    helper = {
        "total_sections": 0,
        "total_units": 0,
        "by_type": {"Foundation": 0, "Major": 0, "SHS": 0, "GS": 0},
        "course_stats": {},  # course_id -> {type, sections, units, score}
        "priority_score": 0,
    }
    for s in ctx.sections:
        helper["total_sections"] += 1
        c = ctx.courses.get(s["course_id"], {})
        units = int(c.get("units") or 3)
        helper["total_units"] += units
        ctype = c.get("type_of_course") or "Major"
        helper["by_type"][ctype] = helper["by_type"].get(ctype, 0) + 1
        stat = helper["course_stats"].setdefault(
            s["course_id"], {"type": ctype, "sections": 0, "units": 0, "score": 0}
        )
        stat["sections"] += 1
        stat["units"] += units
        stat["score"] += weights.get(ctype, 0)
        helper["priority_score"] += weights.get(ctype, 0)
    ctx.kac_helper = helper

def phase2_course_prioritization(ctx: ContextA, kac_priority_order: list[str] | None = None) -> None:
    stats = ctx.kac_helper["course_stats"]
    if kac_priority_order:
        explicit = [cid for cid in kac_priority_order if cid in stats]
        rest = [cid for cid in stats.keys() if cid not in kac_priority_order]
        rest.sort(key=lambda cid: (stats[cid]["score"], stats[cid]["sections"]), reverse=True)
        ctx.course_order = explicit + rest
    else:
        ctx.course_order = sorted(stats.keys(), key=lambda cid: (stats[cid]["score"], stats[cid]["sections"]), reverse=True)

def phase3_kac_prioritization(ctx: ContextA, weights: dict[str, int] | None = None) -> None:
    """
    Build a KAC-first view of demand, then produce a KAC-aware course order.
    - Score each KAC by the sum of (course_type weight * sections) of its member courses
    - Within each KAC, order courses by the same Phase-2 (score, sections) rule
    Produces:
      ctx.kac_order: [kac_id, ...]
      ctx.course_order: [course_id, ...] respecting KAC order
      ctx.kac_debug: details for debug
    """
    if weights is None:
        weights = {"Foundation": 3, "Major": 1, "SHS": 1, "GS": 1}

    # 1) Per-course stats you already computed in phase1
    cstats = (ctx.kac_helper or {}).get("course_stats", {})

    # 2) Aggregate to KACs
    kac_stats: dict[str, dict] = {}   # kac_id -> {score, sections, units, courses:[...]}
    for cid, st in cstats.items():
        # if a course has no KAC, we drop it into a pseudo bucket "_UNK"
        kset = (getattr(ctx, "course_to_kacs", {}) or {}).get(cid) or {"_UNK"}
        for kid in kset:
            ks = kac_stats.setdefault(kid, {"score": 0, "sections": 0, "units": 0, "courses": []})
            # score contribution = weight(type) * sections (or st['score'] if you prefer)
            w = weights.get(st["type"], 0)
            ks["score"]    += w * int(st["sections"] or 0)
            ks["sections"] += int(st["sections"] or 0)
            ks["units"]    += int(st["units"] or 0)
            ks["courses"].append(cid)

    # 3) Order KACs by (score desc, sections desc, kac_id)
    kac_order = sorted(kac_stats.keys(),
                       key=lambda k: (kac_stats[k]["score"], kac_stats[k]["sections"], k),
                       reverse=True)

    # 4) Within each KAC, order its courses the same way Phase-2 does
    def _course_key(cid: str):
        st = cstats[cid]
        hist = getattr(ctx, "hist_by_course", {}).get(cid, 0)
        # weigh by current demand proxy first, then history as tie-breaker
        return (st["score"], st["sections"], hist)


    course_order: list[str] = []
    seen: set[str] = set()
    for kid in kac_order:
        bucket = list({c for c in kac_stats[kid]["courses"] if c in cstats})
        bucket.sort(key=_course_key, reverse=True)
        for cid in bucket:
            if cid not in seen:
                seen.add(cid)
                course_order.append(cid)

    # 5) Some courses might have no KAC mapping; append them at the end
    for cid in cstats.keys():
        if cid not in seen:
            course_order.append(cid)

    # 6) Attach to context for downstream phases and debugging
    ctx.kac_order = kac_order                             # type: ignore[attr-defined]
    ctx.kac_stats = kac_stats                             # type: ignore[attr-defined]
    ctx.course_order = course_order

async def run_milestone_a(term_id: str, db, department_id: str | None = None) -> dict:
    ctx = await phase0_load(term_id, db, department_id)
    phase1_kac_helpers(ctx)
    phase2_course_prioritization(ctx)
    # return a minimal, inspectable payload (no assignments yet)
    return {
        "term_id": term_id,
        "kac_helper": ctx.kac_helper,
        "course_order": ctx.course_order,
        "counts": {
            "sections": len(ctx.sections),
            "courses": len(ctx.courses),
            "faculty": len(ctx.faculty),
            "prefs": len(ctx.prefs_by_faculty),
        },
    }
# =============  END MILESTONE A  =============

# =============  MILESTONE B (Phases 3–4 only; no assignments)  =============
DEFAULT_UNITS = 9  # fallback capacity when nothing else is available

def _display_name_from_users(u: dict) -> str:
    ln = (u or {}).get("last_name") or ""
    fn = (u or {}).get("first_name") or ""
    return f"{ln}, {fn}".strip(", ").strip()

def _faculty_capacities(ctx: ContextA) -> dict[str, int]:
    """
    Remaining-unit capacity per faculty:
    1) previous-term faculty_preferences.preferred_units
    2) else faculty_profiles.remaining_units
    3) else DEFAULT_UNITS
    """
    caps: dict[str, int] = {}
    for f in ctx.faculty:
        fid = f["faculty_id"]
        pref_units = int((ctx.prefs_by_faculty.get(fid) or {}).get("preferred_units") or 0)
        prof_units = int(f.get("remaining_units") or 0)
        caps[fid] = pref_units or prof_units or DEFAULT_UNITS
    return caps

def _campus_compat(f: dict, campus_id_or_name: str) -> bool:
    # map your campus codes → names as needed
    id_to_name = {"CMPS0001": "Manila", "CMPS0002": "Laguna"}
    want = id_to_name.get(campus_id_or_name, campus_id_or_name)
    prefs = f.get("preferred_campus_ids") or []
    if not prefs:
        return True  # no preference == compatible
    allowed = {id_to_name.get(x, x) for x in prefs}
    return want in allowed

def _mode_compat(f: dict, section_mode: str | None) -> bool:
    pref = (f.get("preferred_mode") or "").upper()
    if not pref:
        return True
    m = (section_mode or "HYB").upper()
    if pref == "HYB":            # hybrid accepts any
        return True
    if pref in ("FOL", "ONLINE"): # prefers / accepts online-ish
        return m in ("ONLINE", "HYB")
    return True

def _faculty_priority_key_for_course(f: dict, cap: int) -> tuple[int, int]:
    """
    Lower is better:
      • more capacity first (negative for desc)
      • FT over PT (FT rank=0, PT rank=1)
    """
    emp = (f.get("employment_type") or "").upper()
    ft_rank = 0 if "FULL" in emp else 1
    return (-cap, ft_rank)

# ------------------------------ PHASE 5 ------------------------------
# Protection pools: per-course "coordinator" and dynamic "Top-K"
def _coordinator_for_course(ctx: ContextA, cid: str) -> list[str]:
    c = (ctx.courses or {}).get(cid) or {}
    val = c.get("course_coordinator")
    if not val:
        return []
    if isinstance(val, list):
        return [v for v in val if isinstance(v, str) and v]
    if isinstance(val, str):
        return [val]
    return []

def _compute_topk_for_course(by_course: dict, cid: str, candidates: list[dict], max_topk: int = 5) -> list[str]:
    """
    Phase 5: Dynamic Top-K = min(max_topk, #sections under the course, #candidates), at least 1.
    Returns faculty_ids from the *ranked* candidates list.
    """
    n_sections = len((by_course.get(cid) or {}).get("sections", []))
    k = max(1, min(max_topk, n_sections, len(candidates)))
    return [c["faculty_id"] for c in candidates[:k]]

def _apply_protection_tags(by_course: dict, cid: str, coord_ids: list[str], topk_ids: list[str]) -> None:
    tags = (by_course.setdefault(cid, {})).setdefault("protection_tags", {})
    for fid in coord_ids:
        tags.setdefault(fid, set()).add("coordinator")
    for fid in topk_ids:
        tags.setdefault(fid, set()).add("topK")
    by_course[cid]["protection_tags"] = {fid: sorted(list(v)) for fid, v in tags.items()}
# --------------------------- END PHASE 5 -----------------------------

# =============  MILESTONE C — Phase 6A (Capacity-first matching; no time/day)  =============
# Goal: iterate in KAC→course order, and for each course exhaust the top faculty's
# remaining units on its sections before moving to the next faculty (time/day ignored for now).

def _section_units(ctx: ContextA, cid: str) -> int:
    # prefer course units; fallback to 3
    return int((ctx.courses.get(cid) or {}).get("units") or 3)

def _course_sections(ctx: ContextA, by_course: dict, cid: str) -> list[str]:
    # preserve stable section order within a course
    return list(by_course.get(cid, {}).get("sections", []))

def _promote_coordinators_first(by_course: dict, cid: str, cand_list: list[dict]) -> list[dict]:
    """
    If course has coordinators in protection_tags, promote them to the front while
    preserving the relative order among coordinators and among non-coordinators.
    """
    tags = (by_course.get(cid, {}).get("protection_tags", {})) or {}
    coord_ids = {fid for fid, tg in tags.items() if "coordinator" in tg}
    if not coord_ids:
        return cand_list
    coords, others = [], []
    for c in cand_list:
        (coords if c.get("faculty_id") in coord_ids else others).append(c)
    return coords + others

async def run_milestone_c_phase6a(term_id: str, db, department_id: str | None = None) -> dict:
    """
    Phase 6A: capacity-first, campus/mode-ready (already gated in Phase 5),
    NO time/day checking yet. Produces a list of tentative assignments.
    """
    # Rebuild context + ordering (reuse A/3 logic) and reuse B to get candidates
    ctx = await phase0_load(term_id, db, department_id)
    phase1_kac_helpers(ctx)
    phase3_kac_prioritization(ctx)

    # Build Phase 5 pools (call B once to avoid duplicating candidate logic)
    phase5 = await run_milestone_b(term_id, db, department_id)
    by_course = phase5.get("by_course", {})
    course_order = phase5.get("courses_order", []) or (ctx.course_order or [])

    # capacities (preferred_units → remaining_units → default)
    caps = _faculty_capacities(ctx)

    # quick lookups
    section_to_course = {s["section_id"]: s["course_id"] for s in ctx.sections}
    assigned: dict[str, dict] = {}  # section_id -> assignment doc
    per_course_assigned: dict[str, int] = {}

    # Main loop: KAC→course order
    for cid in course_order:
        sec_ids = [sid for sid in _course_sections(ctx, by_course, cid) if sid not in assigned]
        if not sec_ids:
            continue
        units_per_sec = _section_units(ctx, cid)

        # candidate list — already ranked; coordinators (if any) go first
        cand_list = list(by_course.get(cid, {}).get("candidates", []))
        cand_list = _promote_coordinators_first(by_course, cid, cand_list)

        # exhaust top candidate's units across the course before moving to next
        for c in cand_list:
            fid = c.get("faculty_id")
            if not fid:
                continue
            cap = int(caps.get(fid, 0))
            if cap < units_per_sec:
                continue

            # Assign as many unassigned sections of this course as capacity allows
            i = 0
            while i < len(sec_ids) and cap >= units_per_sec:
                sid = sec_ids[i]
                if sid in assigned:
                    i += 1
                    continue
                # (Phase 6A skips time/day; campus/mode already gated in Phase 5)
                assigned[sid] = {
                    "section_id": sid,
                    "course_id": cid,
                    "faculty_id": fid,
                    "faculty": c.get("name",""),
                    "status": "Pending",
                }
                cap -= units_per_sec
                caps[fid] = cap
                per_course_assigned[cid] = per_course_assigned.get(cid, 0) + 1
                i += 1

            # refresh remaining unassigned list for this course
            sec_ids = [sid for sid in sec_ids if sid not in assigned]
            if not sec_ids:
                break

    # Shape return structure compatible with route
    assignments = list(assigned.values())

    # ------------------------------ PHASE 6A DEBUG ------------------------------
    # Collect per-faculty assignments summary for inspection
    faculty_debug: dict[str, dict] = {}
    for a in assignments:
        fid = a["faculty_id"]
        entry = faculty_debug.setdefault(fid, {"faculty": a.get("faculty", ""), "courses": set()})
        entry["courses"].add(a["course_id"])
    # Build readable list (include ALL faculty, even with no assignments)
    phase6a_faculty_debug = []
    assigned_map = {}  # faculty_id -> set(courses)
    for a in assignments:
        assigned_map.setdefault(a["faculty_id"], set()).add(a["course_id"])

    for f in ctx.faculty:
        fid = f["faculty_id"]
        phase6a_faculty_debug.append({
            "faculty_id": fid,
            "faculty_name": _display_name_from_users(ctx.users_by_faculty.get(fid)),
            "remaining_units": int(caps.get(fid, 0)),
            "courses_assigned": sorted(list(assigned_map.get(fid, set()))),
        })
    # ---------------------------------------------------------------------------

    debug6a = {
        "phase6a_assigned_total": len(assignments),
        "phase6a_per_course": per_course_assigned,
        "phase6a_caps_left": {k: int(v) for k, v in caps.items()},
        "phase6a_faculty_debug": phase6a_faculty_debug,   # NEW detailed list
    }

    # Keep by_course and earlier debug fields for inspection
    return {
        "term_id": term_id,
        "courses_order": course_order,
        "by_course": by_course,
        "assignments": assignments,
        "debug": {**(phase5.get("debug", {}) or {}), **debug6a},
    }

# =============  END MILESTONE C — Phase 6A  ==========================

async def run_milestone_b(term_id: str, db, department_id: str | None = None) -> dict:
    """
    Outputs ordered worklist with per-course prioritized faculty pools,
    but DOES NOT perform the matching yet.
    """
    ctx = await phase0_load(term_id, db, department_id)
    phase1_kac_helpers(ctx)                  # Phase 1: course-level stats
    phase3_kac_prioritization(ctx)           # Phase 3: KAC-first ordering (sets ctx.course_order)

    caps = _faculty_capacities(ctx)

    # sections grouped by course
    by_course: dict[str, dict] = {}
    for s in ctx.sections:
        cid = s["course_id"]
        by_course.setdefault(cid, {"sections": [], "candidates": []})
        by_course[cid]["sections"].append(s["section_id"])

    # build prioritized candidate list per course (capacity, FT/PT, campus/mode)
    for cid in (ctx.course_order or []):
        # peek any section under the course to read campus/mode (good enough for B)
        any_sec = next((x for x in ctx.sections if x["course_id"] == cid), None) or {}
        campus = any_sec.get("campus_id") or any_sec.get("campus") or ""
        mode   = any_sec.get("mode") or "HYB"

        cands: list[dict] = []
        # ——— KAC set for this course comes from the KAC collection mapping we built in Phase 0
        course_kacs = set((getattr(ctx, "course_to_kacs", {}) or {}).get(cid, set()))

        # small counters for debug
        dbg_total = 0
        dbg_kac_ok = 0
        dbg_campus_mode_ok = 0
        dbg_time_ok = 0

        for f in ctx.faculty:
            fid = f["faculty_id"]
            dbg_total += 1
            cap = int(caps.get(fid, 0))
            if cap <= 0:
                continue

            # (A) LEAVE blackout (optional, from previous-term prefs payload)
            fpref = (ctx.prefs_by_faculty.get(fid) or {})
            ld = fpref.get("leave_data") or {}
            st = (ld or {}).get("start_term_id"); et = (ld or {}).get("end_term_id")
            # If both bounds exist and current term_id is inside, skip
            if st and et and (st <= ctx.term_id <= et):
                continue

            # (B) KAC gate: allow preferred KACs to count, then union with qualified
            pref_kacs = set((fpref.get("preferred_kacs") or fpref.get("preferred_kac") or []))
            qual_kacs = set(f.get("qualified_kacs") or f.get("kac_ids") or [])
            fac_kacs_union = pref_kacs | qual_kacs

            # If the course belongs to one or more KACs, require a non-empty intersection
            if course_kacs and not (fac_kacs_union and course_kacs.intersection(fac_kacs_union)):
                by_course.setdefault(cid, {})  # REMOVE after debugging FROM HERE
                by_course[cid].setdefault("_why", []).append({
                    "fid": fid,
                    "union_size": len(fac_kacs_union),
                    "course_kacs": sorted(list(course_kacs)),
                    "pref_kacs": sorted(list(pref_kacs)),
                    "qual_kacs": sorted(list(qual_kacs)),
                }) # REMOVE after debugging TO HERE
                continue
            dbg_kac_ok += 1

            # (C) Campus / mode gates
            # Merge campus prefs from profile + previous-term prefs
            pref_campus_ids = set((fpref.get("campus_id") or []))
            fac_campus_ids  = set(f.get("preferred_campus_ids") or [])
            if pref_campus_ids and not fac_campus_ids:
                # reflect preference campuses in the same field the helper uses
                f = {**f, "preferred_campus_ids": list(pref_campus_ids)}

            # (C) Campus / mode gates
            if not _campus_compat(f, campus):
                continue
            if not _mode_compat(f, mode):
                continue
            dbg_campus_mode_ok += 1

            # (D) If any section already has real schedules, require at least one overlap with pref windows
            sec_ids = by_course[cid]["sections"]
            sec_has_sched = any(ctx.schedules_by_section.get(sid) for sid in sec_ids)
            if sec_has_sched:
                pref_windows = []
                for t in (fpref.get("preferred_times") or []):
                    if "-" in t:
                        a, b = t.split("-", 1)
                        pref_windows.append((a.replace(":", ""), b.replace(":", "")))
                if pref_windows:
                    ok_overlap = False
                    for sid in sec_ids[:2]:
                        for sch in (ctx.schedules_by_section.get(sid) or []):
                            stt = str(sch.get("start_time") or sch.get("start") or "").replace(":", "")
                            ett = str(sch.get("end_time") or sch.get("end") or "").replace(":", "")
                            if not (stt and ett):
                                continue
                            for ps, pe in pref_windows:
                                if int(ps) < int(ett) and int(stt) < int(pe):
                                    ok_overlap = True; break
                            if ok_overlap: break
                        if ok_overlap: break
                    if not ok_overlap:
                        continue
            dbg_time_ok += 1

            # (E) Course-aware scoring
            hx = int(getattr(ctx, "history_map", {}).get((fid, cid), 0))
            # reuse pref_kacs from above; we also have fac_kacs_union
            prefers_this_kac = 1 if (course_kacs and pref_kacs and course_kacs.intersection(pref_kacs)) else 0
            qual_matches_union = 1 if (course_kacs and course_kacs.intersection(fac_kacs_union)) else 0
            emp = (f.get("employment_type") or "").upper()
            ft_bonus = 1 if "FULL" in emp else 0

            # weights: preference > history > FT > being in qualified/union > capacity
            # (adds separation so scores aren’t all “cap-only” ties)
            score = (40*prefers_this_kac) + (25*hx) + (10*ft_bonus) + (5*qual_matches_union) + min(cap, 12)

            name = _display_name_from_users(ctx.users_by_faculty.get(fid))
            cands.append({
                "faculty_id": fid,
                "name": name,
                "remaining_units": cap,
                "employment_type": f.get("employment_type", ""),
                "score": score,
            })

        # sort: higher score first, then more capacity, then FT, then name
        cands.sort(key=lambda x: (-x["score"], -x["remaining_units"],
                                  0 if (x["employment_type"] or "").upper().startswith("FULL") else 1,
                                  x["name"]))

        by_course[cid]["candidates"] = cands

        # ------------------------------ PHASE 5 ------------------------------
        # Coordinator + Dynamic Top-K protection pools
        coord_ids: list[str] = _coordinator_for_course(ctx, cid)  # returns []
        topk_ids: list[str] = _compute_topk_for_course(by_course, cid, cands, max_topk=5)

        # If any coordinator is a valid candidate but not in Top-K, still protect them
        cand_ids = {c["faculty_id"] for c in cands}
        for fid in coord_ids:
            if fid in cand_ids and fid not in topk_ids:
                topk_ids.append(fid)

        # normalize Top-K (dedup while preserving order)
        topk_ids = list(dict.fromkeys(topk_ids))

        _apply_protection_tags(by_course, cid, coord_ids, topk_ids)
        # --------------------------- END PHASE 5 -----------------------------

        by_course[cid]["_debug_filters"] = {
            "pool": dbg_total,
            "after_kac": dbg_kac_ok,
            "after_campus_mode": dbg_campus_mode_ok,
            "after_time": dbg_time_ok,
            "final_candidates": len(cands),
        }

        # ---------- DEBUG: Phases 3–5 ----------
    # Phase 3 (KAC / course-type weighting) — show per-course score + sections
    dbg_phase3 = []
    stats = ctx.kac_helper.get("course_stats", {}) if ctx.kac_helper else {}
    for cid, st in stats.items():
        dbg_phase3.append({
            "course_id": cid,
            "type": st.get("type"),
            "sections": st.get("sections"),
            "units": st.get("units"),
            "score": st.get("score"),
        })
    # sort descending by score then sections (matches how we prioritize)
    dbg_phase3.sort(key=lambda x: (x["score"], x["sections"]), reverse=True)

    # Phase 4 (course prioritization) — the final ordered list we’ll process
    dbg_phase4 = ctx.course_order or []

    # Phase 5 (faculty prioritization per course) — top N with score breakdown
    TOP_N = 5
    dbg_phase5 = {}
    for cid in (ctx.course_order or []):
        candlist = by_course.get(cid, {}).get("candidates", [])
        # include score rationale if present
        dbg_phase5[cid] = [
            {
                "faculty_id": c.get("faculty_id"),
                "name": c.get("name"),
                "remaining_units": c.get("remaining_units"),
                "employment_type": c.get("employment_type"),
                "score": c.get("score"),
            }
            for c in candlist[:TOP_N]
        ]

        # KAC debug (Phase 3): ranked KACs and their aggregates
    dbg_kac_rank = []
    for kid in (getattr(ctx, "kac_order", []) or []):
        ks = getattr(ctx, "kac_stats", {}).get(kid, {})
        dbg_kac_rank.append({
            "kac_id": kid,
            "kac_name": ((getattr(ctx, "kacs", {}) or {}).get(kid) or {}).get("kac_name", ""),
            "score": ks.get("score", 0),
            "sections": ks.get("sections", 0),
            "units": ks.get("units", 0),
            "courses": list(dict.fromkeys(ks.get("courses", []))),  # unique preserve order
        })

    # collect per-course filter counts in course order for readability
    dbg_filters = {
        cid: by_course.get(cid, {}).get("_debug_filters", {})
        for cid in (ctx.course_order or [])
    }

    debug_payload = {
        "phase3_kac_course_stats": dbg_phase3,
        "phase3_kac_rank": dbg_kac_rank,
        "phase4_course_order": dbg_phase4,
        "phase5_top_candidates": dbg_phase5,
        "phase5_filter_counts": dbg_filters,
        "phase5_kac_why": {cid: by_course[cid].get("_why", []) for cid in (ctx.course_order or [])},
        # ------------------------------ PHASE 5 ------------------------------
        "phase5_protection_tags": {
            cid: (by_course.get(cid, {}).get("protection_tags", {}))
            for cid in (ctx.course_order or [])
        },
        # --------------------------- END PHASE 5 -----------------------------
    }

    return {
        "term_id": term_id,
        "courses_order": ctx.course_order or [],
        "by_course": by_course,
        # keep assignments empty in Milestone B (no matching yet)
        "assignments": [],
        "debug": debug_payload, 
    }

# =============  END MILESTONE B  =============
async def compute_load_recommendations(
    term_id: str,
    db,
    *,
    department_id: str | None = None,
    respect_locks: bool = True,
) -> dict:
    """
    Switchable milestones:
      A → data prep only
      B → prioritization only (no assignments)
      C+ → matching (later)
    """
    MILESTONE = "C"  # A=data prep, B=prioritization only, C=Phase 6A (capacity-first)

    if MILESTONE == "A":
        dbg = await run_milestone_a(term_id, db, department_id)
        return {
            "term_id": term_id,
            "courses_order": dbg.get("course_order", []),
            "by_course": {},
            "assignments": [],
        }

    if MILESTONE == "B":
        return await run_milestone_b(term_id, db, department_id)

    if MILESTONE == "C":
        return await run_milestone_c_phase6a(term_id, db, department_id)

    return {"term_id": term_id, "courses_order": [], "by_course": {}, "assignments": []}