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
from collections import defaultdict

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
COL_LEAVES = "leaves"
COL_PREFERENCES = "faculty_preferences"
COL_FACULTY_LOADS = "faculty_loads"

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)

async def _next_load_id(db) -> str:
    """
    Find the last load_id in faculty_loads and return the next one, e.g.
    LOAD0004 -> LOAD0005. If none, start at LOAD0001.
    """
    rows = await db[COL_FACULTY_LOADS].find(
        {}, {"_id": 0, "load_id": 1}
    ).sort("load_id", -1).to_list(1)

    last = (rows[0]["load_id"] if rows and rows[0].get("load_id") else None)
    if not last or not last.startswith("LOAD"):
        return "LOAD0001"

    num_part = last.replace("LOAD", "")
    try:
        n = int(num_part) + 1
    except ValueError:
        n = 1
    return f"LOAD{n:04d}"

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

# DEBUG function
async def _faculty_on_leave_map(db, active_term_id: str):
    leaves = await db["leaves"].find(
        {
            "approval_status": "APPROVED",
            "is_active": True,
        },
        {"_id": 0, "faculty_id": 1, "start_term_id": 1, "end_term_id": 1},
    ).to_list(None)

    term_list = await db["terms"].find({}, {"_id": 0, "term_id": 1}).sort([
        ("acad_year_start", 1),
        ("term_number", 1)
    ]).to_list(None)
    term_ids = [t["term_id"] for t in term_list]
    active_idx = term_ids.index(active_term_id) if active_term_id in term_ids else -1

    blocked = set()
    for lv in leaves:
        if lv["start_term_id"] in term_ids and lv["end_term_id"] in term_ids:
            s = term_ids.index(lv["start_term_id"])
            e = term_ids.index(lv["end_term_id"])
            if s <= active_idx <= e:
                blocked.add(lv["faculty_id"])

    print(f"[DEBUG] Active term: {active_term_id}, blocked faculty: {blocked}")
    return blocked

# --- Day-pair normalization helpers -----------------------------------------
DAY_PAIR = {
    "M": "H",  # Monday ↔ Thursday
    "H": "M",
    "T": "F",  # Tuesday ↔ Friday
    "F": "T",
    "W": "S",  # Wednesday ↔ Saturday
    "S": "W",
}
DAY_ORDER_INDEX = {"M": 0, "H": 1, "T": 0, "F": 1, "W": 0, "S": 1}

def _normalize_pair_order(
    d1: str | None, b1: str | None, e1: str | None,
    d2: str | None, b2: str | None, e2: str | None,
):
    """
    Rules:
      1) If only slot2 is filled, promote it to slot1.
      2) If both days exist and are a valid pair (M/H, T/F, W/S) but in reverse order,
         swap so day1 is the pair's canonical 'first' (M,T,W).
      3) If both days exist but not a valid pair, keep as-is (we only normalize valid pairs).
      4) If both days are same, keep slot1 and blank slot2.
    """
    # 1) promote slot2 -> slot1 when slot1 is empty
    if not d1 and d2:
        d1, b1, e1, d2, b2, e2 = d2, b2, e2, None, None, None
        return d1, b1, e1, d2, b2, e2

    # If both empty or only slot1 present, nothing to do
    if not d1 or not d2:
        return d1, b1, e1, d2, b2, e2

    D1, D2 = (d1 or "").upper(), (d2 or "").upper()

    # 4) identical days -> drop slot2
    if D1 == D2:
        return d1, b1, e1, None, None, None

    # Check if they are a recognized pair
    is_pair = DAY_PAIR.get(D1) == D2 or DAY_PAIR.get(D2) == D1
    if not is_pair:
        return d1, b1, e1, d2, b2, e2  # unrelated days; leave as-is

    # Make sure day1 is the canonical 'first' (M/T/W indices are 0)
    i1 = DAY_ORDER_INDEX.get(D1)
    i2 = DAY_ORDER_INDEX.get(D2)
    if i1 is None or i2 is None:
        return d1, b1, e1, d2, b2, e2

    # If slot1 is the 'second' of the pair, swap
    if i1 == 1 and i2 == 0:
        d1, b1, e1, d2, b2, e2 = d2, b2, e2, d1, b1, e1

    return d1, b1, e1, d2, b2, e2

def _derive_mode(section: Dict[str, Any],
                 scheds: List[Dict[str, Any]],
                 course: Dict[str, Any],
                 pref_mode: Optional[str] = None) -> str:
    """
    Decide effective mode (optimized rule):
      1) If section.mode is explicitly set → use it.
      2) Else if there’s an assigned faculty preference → use it.
      3) Else → return "" (unset). We do NOT infer from schedules or course.
    """
    def _norm(x: Any) -> str:
        return str(x or "").strip().upper()

    m = _norm(section.get("mode"))
    if m in {"HYB", "FOL", "ONLINE", "ONSITE"}:
        return m

    pm = _norm(pref_mode)
    if pm in {"HYB", "FOL", "ONLINE", "ONSITE"}:
        return pm

    return ""  # leave unset when no section mode and no faculty preference

def _looks_like_room_id(v: str | None) -> bool:
    s = (v or "").strip().upper()
    return s.startswith("ROOM")

def _preferred_cap_for(ctx, fid: str) -> int:
    pref = (getattr(ctx, "prefs_by_faculty", {}) or {}).get(fid, {}) or {}
    return int(pref.get("preferred_units") or pref.get("load_units") or 12)

async def _fetch_rows(user_id: str, term_id: str, db) -> Dict[str, Any]:
    pipe: List[Dict[str, Any]] = [
        {"$match": {"term_id": term_id}} if term_id else {"$match": {}},

        {"$lookup": {"from": COL_COURSES, "localField": "course_id", "foreignField": "course_id", "as": "course"}},
        {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
        {
        "$match": {
            "$or": [
                {"course.type_of_course": {"$in": ["Major", "Foundation", "SHS", "GS"]}},
                {"course.type": {"$in": ["Major", "Foundation", "SHS", "GS"]}},]}},

        {"$lookup": {"from": COL_SCHED, "localField": "section_id", "foreignField": "section_id", "as": "scheds"}},

        # optional current assignment (0..1)
        {"$lookup": {"from": COL_ASSIGN, "localField": "section_id", "foreignField": "section_id", "as": "asg"}},
        {"$unwind": {"path": "$asg", "preserveNullAndEmptyArrays": True}},

        # join faculty + user to display name
        {"$lookup": {"from": COL_FACULTY, "localField": "asg.faculty_id", "foreignField": "faculty_id", "as": "fac"}},
        {"$unwind": {"path": "$fac", "preserveNullAndEmptyArrays": True}},

        # NEW: pull all prefs for that faculty (we'll pick the active term in Python)
        {"$lookup": {"from": COL_PREFERENCES, "localField": "asg.faculty_id", "foreignField": "faculty_id", "as": "fprefs"}},

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

    def schedule_pair(
        scheds: List[Dict[str, Any]],
        section: Dict[str, Any],
        course: Dict[str, Any],
        mode_override: Optional[str] = None,   # NEW
    ) -> Dict[str, str]:
        s1 = (scheds[0] if len(scheds) > 0 else {}) or {}
        s2 = (scheds[1] if len(scheds) > 1 else {}) or {}

        # Decide effective mode FIRST, then rooms use that
        mode = _derive_mode(section, scheds, course, pref_mode=mode_override)
        campus_id = (section.get("campus_id") or "").strip().upper()
        course_rt = (course.get("room_type") or "").strip()

        def _fallback_from_policy(slot_ord: int, s: Dict[str, Any]) -> str:
            """Return placeholder room for this slot (1 or 2) using your rules."""
            # If DB already has explicit values, use them.
            rid = (s.get("room_id") or "").strip()
            rty = (s.get("room_type") or "").strip()
            if rty in ("Online", "TBA", "Classroom"):
                return rty
            if rid:
                return rid

            # Policy when empty:
            if mode == "HYB":
                if campus_id == "CMPS0001":
                    # Manila: room1 Online, room2 course room (or TBA)
                    if slot_ord == 1:
                        return "Online"
                    return course_rt or "TBA"
                if campus_id == "CMPS0002":
                    # Laguna: swap
                    if slot_ord == 1:
                        return course_rt or "TBA"
                    return "Online"
            elif mode == "FOL":
                # Fully online: both Online
                return "Online"

            if not mode:
                return ""  # leave blank; UI shows "—"
            # (keep any other explicit modes if you add later)
            return ""

        def _get_day(s: Dict[str, Any]) -> str:
            return (s.get("day") or s.get("day_of_week") or s.get("day1") or s.get("day2") or "") or ""
        def _get_start(s: Dict[str, Any]) -> str:
            return _fmt_time(s.get("start_time") or s.get("begin") or s.get("begin1") or s.get("start"))
        def _get_end(s: Dict[str, Any]) -> str:
            return _fmt_time(s.get("end_time") or s.get("end") or s.get("end1") or s.get("finish"))

        return {
            "day1": _get_day(s1),
            "begin1": _get_start(s1) or "",
            "end1": _get_end(s1) or "",
            "room1": _fallback_from_policy(1, s1),
            "day2": _get_day(s2),
            "begin2": _get_start(s2) or "",
            "end2": _get_end(s2) or "",
            "room2": _fallback_from_policy(2, s2),
        }

    rows_by_sid: Dict[str, Dict[str, Any]] = {}
    for d in docs:
        sid = d.get("section_id") or ""
        if not sid:
            continue

        course_doc = (d.get("course") or {})
        scheds = (d.get("scheds") or [])

        # --- Faculty preference mode for current term ---
        pref_mode = ""
        fid = (d.get("asg") or {}).get("faculty_id")
        if fid:
            for p in (d.get("fprefs") or []):
                if p.get("term_id") == term_id and p.get("is_finished"):
                    pref_mode = ((p.get("mode") or {}).get("mode")
                                or p.get("preferred_mode") or "").strip().upper()
                    if pref_mode:
                        break
        
        # Compute effective mode once (section → pref → scheds → course)
        effective_mode = _derive_mode(d, scheds, course_doc, pref_mode=pref_mode or None)

        # Rooms are derived using that same mode
        pair = schedule_pair(scheds, d, course_doc, mode_override=effective_mode)

        # Display uses the effective mode
        mode_display = effective_mode

        rows_by_sid[sid] = {
            "id": sid,
            "course": d.get("course_code_display") or "",
            "title": course_doc.get("course_title","") or "",
            "units": course_doc.get("units","") or "",
            "section": d.get("section_code","") or "",
            # NEW: keep both faculty_id and display name so manual edits can persist correctly
            "faculty_id": (d.get("asg") or {}).get("faculty_id") or "",
            "faculty": d.get("faculty_name_display","") or "",
            **pair,
            "capacity": d.get("enrollment_cap","") or "",
            "mode": mode_display,
            "status": "Pending" if (d.get("asg") or {}).get("faculty_id") else "Unassigned",
        }

    rows = list(rows_by_sid.values())
    return {"rows": rows}

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
    ay = t["acad_year_start"]
    return f"AY {ay}-{ay+1} T{t['term_number']}"

router = APIRouter(prefix="/om", tags=["om"])

@router.post("/loadassignment")
async def loadassignment_handler(
    userId: str = Query(..., min_length=3),
    action: str = Query("fetch", description="fetch | options | profile | submit"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    if action == "fetch":
        active = await _active_term()
        if not active:
            raise HTTPException(409, "No upcoming term found (is_current anchor missing?)")
        data = await _fetch_rows(userId, term_id=active["term_id"], db=db)
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

    # --- inside loadassignment_handler(), replace the current "profile" branch ---
    if action == "profile":
        # --- existing lookups (users/staff) can stay as-is ---
        staff = await db["staff_profiles"].find_one(
            {"user_id": userId},
            {"_id": 0, "staff_id": 1, "position_title": 1}
        ) or {}

        u = await db["users"].find_one(
            {"user_id": userId},
            {"_id": 0, "first_name": 1, "last_name": 1}
        ) or {}
        full_name = " ".join([p for p in [(u.get("first_name") or "").strip(),
                                        (u.get("last_name") or "").strip()] if p])

        # --- NEW: resolve department via role_assignments -> departments ---
        # Grab the most recent active role assignment for this user
        ra = await db["role_assignments"].find(
            {
                "user_id": userId,
                # treat null/absent as active; you can tighten this if you track current term
                "$or": [{"is_active": True}, {"is_active": {"$exists": False}}],
            },
            {
                "_id": 0,
                "role_id": 1,
                "scope": 1,
                "updated_at": 1,
                "created_at": 1,
                "until_term_id": 1,
            },
        ).sort([("updated_at", -1), ("created_at", -1)]).to_list(5)

        dept_id = None
        role_id = None
        for row in ra or []:
            role_id = role_id or row.get("role_id")
            scopes = row.get("scope") or []
            # find the first department scope
            dep_scope = next((s for s in scopes if (s.get("type") == "department" and s.get("id"))), None)
            if dep_scope:
                dept_id = dep_scope["id"]
                break

        dept_name = ""
        if dept_id:
            d = await db["departments"].find_one(
                {"department_id": dept_id},
                {"_id": 0, "dept_name": 1, "department_name": 1, "name": 1, "dept_code": 1},
            ) or {}
            dept_name = (d.get("dept_name") or d.get("department_name") or d.get("name") or "").strip()

        # Optional: normalize role display (example for ROLE0006)
        position_title = staff.get("position_title") or ""
        if not position_title and role_id == "ROLE0006":
            position_title = "Office Manager"

        return {
            "ok": True,
            "full_name": full_name,
            "position_title": position_title,
            "dept_name": dept_name,
            # keep any other fields you already return
        }

    if action == "save":
        # same validation as approve
        if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list):
            raise HTTPException(
                status_code=400,
                detail="Invalid payload; expected { rows: [...] }",
            )

        active = await _active_term()
        if not active:
            raise HTTPException(
                409, "No upcoming term found (is_current anchor missing?)"
            )

        rows = payload["rows"]

        # Just persist assignments/schedules – no faculty_loads header yet
        await _approve_and_persist(active["term_id"], rows, db)

        return {
            "ok": True,
            "saved": len(rows),
            "term": _term_label(active),
        }

    if action == "submit":
        # Validate
        if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list):
            raise HTTPException(status_code=400, detail="Invalid payload; expected { rows: [...] }")
        submitted_rows = payload["rows"]
        return {"ok": True, "rows": submitted_rows}

    if action == "approve":
        if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list):
            raise HTTPException(
                status_code=400,
                detail="Invalid payload; expected { rows: [...] }",
            )

        active = await _active_term()
        if not active:
            raise HTTPException(
                409, "No upcoming term found (is_current anchor missing?)"
            )

        rows = payload["rows"]

        # 1) persist the final assignments/schedules
        await _approve_and_persist(active["term_id"], rows, db)

        # 2) create/update faculty_loads header for this term
        await _upsert_faculty_load_header(
            active,
            db,
            department_id="DEPT0001",  # per your spec
            user_id=userId,            # query param from the route
        )

        return {
            "ok": True,
            "approved": len(rows),
            "term": _term_label(active),
        }


    raise HTTPException(status_code=400, detail="Invalid action parameter.")

@router.get("/load-assignment/faculty-all")
async def om_get_all_faculty(db = Depends(get_db)):
    pipeline = [
        {
            "$match": {"is_archived": {"$ne": True}}
        },
        {
            "$lookup": {
                "from": "users",
                "localField": "user_id",
                "foreignField": "user_id",
                "as": "user"
            }
        },
        {
            "$unwind": "$user"
        },
        {
            "$set": {
                "faculty_name_display": {
                    "$concat": ["$user.last_name", ", ", "$user.first_name"]
                }
            }
        },
        {
            "$project": {
                "_id": 0,
                "faculty_id": 1,
                "faculty_name_display": 1
            }
        },
        {
            "$sort": {
                "faculty_name_display": 1
            }
        }
    ]
    docs = await db[COL_FACULTY].aggregate(pipeline).to_list(None)
    return {"ok": True, "faculty": docs}

@router.get("/load-assignment/list")
async def get_om_load_assignment_list(user_id: str, db=Depends(get_db)):
    active = await _active_term()

    # Fetch table rows
    base = await _fetch_rows(user_id, term_id=active["term_id"], db=db)
    rows = base["rows"]

    # Get faculty preferences for the active term
    ctx = await phase0_load(active["term_id"], db)
    fac_prefs = ctx.prefs_by_faculty or {}

    # Build preferred units map
    preferred_units_by_faculty = {}
    for fid, pref in fac_prefs.items():
        val = pref.get("preferred_units") or pref.get("load_units")
        try:
            if val:
                preferred_units_by_faculty[fid] = int(val)
        except:
            continue

    return {
        "term": _term_label(active),
        "rows": rows,
        "preferred_units_by_faculty": preferred_units_by_faculty,   #  ← NEW
    }

@router.post("/load-assignment/run")
async def run_auto_assignment(
    user_id: str = Query(..., alias="user_id"),
    department_id: str | None = Query(None),
    db = Depends(get_db),
):
    active = await _active_term()
    if not active:
        raise HTTPException(409, "No upcoming term found (is_current anchor missing?)")

    # Require finished prefs for the upcoming term
    pref_cnt = await db[COL_PREFERENCES].count_documents(
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

    # Prefs (used for alt-window search on duplicates)
    ctx_for_prefs = await phase0_load(active["term_id"], db, department_id=department_id)
    fac_prefs = ctx_for_prefs.prefs_by_faculty or {}

    # Build a quick map → faculty_id -> preferred_mode (from faculty_preferences.mode.mode)
    fac_pref_mode: dict[str, str] = {}
    for fid, pref in (ctx_for_prefs.prefs_by_faculty or {}).items():
        mode_obj = pref.get("mode") or {}
        mode_str = str(mode_obj.get("mode") or "").strip().upper()
        if fid and mode_str:
            fac_pref_mode[fid] = mode_str

    # Build a quick map → faculty_id -> preferred_units (or load_units fallback)
    preferred_units_by_faculty: dict[str, int] = {}
    for fid, pref in fac_prefs.items():
        val = pref.get("preferred_units") or pref.get("load_units")
        try:
            if val is not None:
                preferred_units_by_faculty[fid] = int(val)
        except (TypeError, ValueError):
            # ignore bad values; you can also default to 12 if you want
            continue

    prefs_debug = {
        "preferred_units_by_faculty": preferred_units_by_faculty
    }

    # NEW: section_id → campus_id and course_room_type
    sid_to_campus: dict[str, str] = {
        s["section_id"]: str(s.get("campus_id") or "")
        for s in (ctx_for_prefs.sections or [])
        if s.get("section_id")
    }
    sid_to_course: dict[str, str] = {
        s["section_id"]: s.get("course_id")
        for s in (ctx_for_prefs.sections or [])
        if s.get("section_id") and s.get("course_id")
    }
    sid_to_crt: dict[str, str] = {}
    for sid, cid in sid_to_course.items():
        c = (ctx_for_prefs.courses or {}).get(cid, {})
        rt = str(c.get("room_type") or "").strip()
        sid_to_crt[sid] = rt  # e.g., "Classroom", "Comlab", "Online", or ""

    # Track used slots per faculty to avoid duplicates
    used: dict[str, set[tuple[str, str, str]]] = {}

    def _add_used(fid: str | None, day: str | None, b: str | None, e: str | None):
        if fid and day and b and e:
            used.setdefault(str(fid), set()).add((day.upper(), str(b), str(e)))

    def _would_reuse(fid, day, b, e):
        if not (fid and day and b and e):
            return False
        return (day.upper(), str(b), str(e)) in used.get(str(fid), set())

    def _parse_win_to_hhmm_pair(win) -> tuple[str, str] | None:
        st = _to_min(win.get("start") or win.get("begin")) if isinstance(win, dict) else None
        en = _to_min(win.get("end") or win.get("finish")) if isinstance(win, dict) else None
        if isinstance(win, (list, tuple)) and len(win) == 2:
            st, en = _to_min(win[0]), _to_min(win[1])
        if isinstance(win, str) and "-" in win:
            a, b = win.replace("–", "-").replace("—", "-").split("-", 1)
            st, en = _to_min(a), _to_min(b)
        return (_mm_to_hhmm(st), _mm_to_hhmm(en)) if (st is not None and en is not None and st >= 0 and en > st) else None

    # Standard grid you listed
    GRID = [
        ("07:30", "09:00"),
        ("09:15", "10:45"),
        ("11:00", "12:30"),
        ("12:45", "14:15"),
        ("14:30", "16:00"),
        ("16:15", "17:45"),
        ("18:00", "19:30"),
        ("19:45", "21:15"),
    ]

    def _pick_alt_slot(fid: str, day: str, pref: dict) -> tuple[str, str] | None:
        # 1) try other explicit preferred windows first
        wins = pref.get("preferred_times")
        if wins:
            seq = wins if isinstance(wins, list) else [wins]
            for w in seq:
                hhmm = _parse_win_to_hhmm_pair(w)
                if not hhmm:
                    continue
                b_alt, e_alt = hhmm
                if not _would_reuse(fid, day, b_alt, e_alt):
                    return (b_alt, e_alt)

        # 2) fallback: iterate the standard grid for that day
        for b_alt, e_alt in GRID:
            if not _would_reuse(fid, day, b_alt, e_alt):
                return (b_alt, e_alt)

        return None
    
    # Seed current used slots from table rows
    for r in rows:
        fid = r.get("faculty_id") or None
        _add_used(fid, r.get("day1"), r.get("begin1"), r.get("end1"))
        _add_used(fid, r.get("day2"), r.get("begin2"), r.get("end2"))

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
                **prefs_debug,
                "candidate_sizes": {
                    cid: len(info.get("candidates", []))
                    for cid, info in (sugg.get("by_course", {}) or {}).items()
                },
            },
        }

    suggestions = {s["section_id"]: s for s in sugg.get("assignments", [])}

    overlay_reasons: dict[str, dict] = {}
    for r in rows:
        a = suggestions.get(r["id"])
        if not a:
            continue

        fid = a.get("faculty_id")
        d1, b1, e1 = a.get("day1"), a.get("begin1"), a.get("end1")
        d2, b2, e2 = a.get("day2"), a.get("begin2"), a.get("end2")
        why: dict[str, str] = {}

        if _would_reuse(fid, d1, b1, e1):
            alt = _pick_alt_slot(fid, (d1 or "").upper(), fac_prefs.get(fid, {}))
            if alt:
                b1, e1 = alt
                why["slot1"] = "picked_alt_pref_window"
            else:
                d1 = b1 = e1 = None
                why["slot1"] = "duplicate_slot_removed"

        if _would_reuse(fid, d2, b2, e2):
            alt = _pick_alt_slot(fid, (d2 or "").upper(), fac_prefs.get(fid, {}))
            if alt:
                b2, e2 = alt
                why["slot2"] = "picked_alt_pref_window"
            else:
                d2 = b2 = e2 = None
                why["slot2"] = "duplicate_slot_removed"

        old_pair = (d1, d2)
        d1, b1, e1, d2, b2, e2 = _normalize_pair_order(d1, b1, e1, d2, b2, e2)
        if old_pair != (d1, d2):
            why["pairing"] = f"normalized_from_{old_pair}_to_{(d1, d2)}"

        r["faculty"] = a.get("faculty", r["faculty"])

        # NEW: set Mode on the row from assigned faculty’s preferred_mode
        if fid:
            pm = fac_pref_mode.get(fid, "")
            if pm:
                r["mode"] = pm  # rows show the decided mode immediately

        if d1 and b1 and e1:
            r["day1"], r["begin1"], r["end1"] = d1, b1, e1
            _add_used(fid, d1, b1, e1)
        else:
            why.setdefault("slot1", "left_blank")

        if d2 and b2 and e2:
            r["day2"], r["begin2"], r["end2"] = d2, b2, e2
            _add_used(fid, d2, b2, e2)
        else:
            why.setdefault("slot2", "left_blank")

        # --- NEW: derive rooms from row-level mode + campus (only if blank) ---
        def _derive_rooms_from_mode_row(row: dict) -> tuple[str, str]:
            mode = (row.get("mode") or "").strip().upper()
            if not mode:
                return (row.get("room1") or "", row.get("room2") or "")
            sid = row.get("id") or row.get("section_id")
            campus = (sid_to_campus.get(sid) or "").upper()
            crt = sid_to_crt.get(sid) or ""          # course room type (e.g., "Classroom","Comlab","Online")

            # FOL: both Online
            if mode == "FOL":
                return ("Online", "Online")

            # HYB: Manila (CMPS0001) → Online then campus/classroom; Laguna (CMPS0002) reversed
            if mode == "HYB":
                if campus == "CMPS0001":
                    return ("Online", crt or "TBA")
                if campus == "CMPS0002":
                    return (crt or "TBA", "Online")
                # unknown campus → don't guess
                return (row.get("room1") or "", row.get("room2") or "")

            # Other modes: leave as-is
            return (row.get("room1") or "", row.get("room2") or "")

        # Only fill when currently blank (don’t stomp explicit suggestions)
        if not (r.get("room1") or "").strip() or not (r.get("room2") or "").strip():
            dr1, dr2 = _derive_rooms_from_mode_row(r)
            if not (r.get("room1") or "").strip():
                r["room1"] = dr1
            if not (r.get("room2") or "").strip():
                r["room2"] = dr2

        # Keep status/conflict overlay, but if there are times and no faculty, mark Pending
        r["status"] = a.get("status", "Pending")
        if a.get("conflictNote"):
            r["conflictNote"] = a["conflictNote"]

        if not r.get("faculty") and (r.get("day1") or r.get("day2")):
            # cosmetic: rows with proposed times shouldn’t appear as “Unassigned”
            if r.get("status", "").lower() == "unassigned":
                r["status"] = "Pending"


        overlay_reasons[r["id"]] = {
            "faculty_id": fid,
            "input_from_phase7": {
                "day1": a.get("day1"), "begin1": a.get("begin1"), "end1": a.get("end1"),
                "day2": a.get("day2"), "begin2": a.get("begin2"), "end2": a.get("end2"),
            },
            "result_after_overlay": {
                "day1": r.get("day1"), "begin1": r.get("begin1"), "end1": r.get("end1"),
                "day2": r.get("day2"), "begin2": r.get("begin2"), "end2": r.get("end2"),
            },
            "reason": why,
        }

    return {
        "term": _term_label(active),
        "rows": rows,
        "debug": {**debug, **prefs_debug, "overlay_no_time_details": overlay_reasons},
    }

#    ===========================================================
#    =====================  LOAD RECO ==========================
#    ===========================================================

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

    # 3b) Campus-level blocked windows (for now we care about CMPS0002)
    campus_blocked: dict[str, dict[int, list[tuple[int, int]]]] = {}
    for s in sections:
        sid = s.get("section_id")
        campus = (s.get("campus_id") or "").strip().upper()
        if not sid or not campus:
            continue
        slots = _slots_from_scheds(schedules_by_section.get(sid, []))
        if not slots:
            continue
        # Store all CMPS0002 schedules as blocked windows
        if campus == "CMPS0002":
            for di, itv in slots:
                campus_blocked.setdefault(campus, {}).setdefault(di, []).append(itv)

    # Coalesce per day for faster checks later
    for camp, days in campus_blocked.items():
        for di, arr in days.items():
            arr.sort()
            merged: list[tuple[int, int]] = []
            for st, en in arr:
                if not merged or merged[-1][1] <= st:
                    merged.append((st, en))
                else:
                    last_st, last_en = merged[-1]
                    merged[-1] = (last_st, max(last_en, en))
            days[di] = merged

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
            "qualified_kacs": 1,
            "kac_ids": 1,
            "certifications": 1,
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
    pref_rows = await db[COL_PREFERENCES].find(
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
            "mode": 1,
        },
    ).to_list(None)
    prefs_by_faculty = {
        r["faculty_id"]: r for r in pref_rows if r.get("faculty_id")
    }

    # after prefs_by_faculty (DEBUG)
    debug_pref_windows = {}
    for fid, p in prefs_by_faculty.items():
        times = p.get("preferred_times")
        ok = 0; bad = 0
        seq = times if isinstance(times, list) else ([times] if times else [])
        for t in seq:
            pair = None
            if isinstance(t, dict):
                pair = (_to_min(t.get("start") or t.get("begin")), _to_min(t.get("end") or t.get("finish")))
            elif isinstance(t, (list, tuple)) and len(t) == 2:
                pair = (_to_min(t[0]), _to_min(t[1]))
            elif isinstance(t, str) and "-" in t:
                a, b = t.replace("–","-").replace("—","-").split("-", 1)
                pair = (_to_min(a), _to_min(b))
            if pair and pair[0] >= 0 and pair[1] > pair[0]:
                ok += 1
            else:
                bad += 1
        if ok + bad:
            debug_pref_windows[fid] = {"ok_windows": ok, "bad_windows": bad}

    # Keep historical field name but set to current term (since 'target = next' is already satisfied)
    prefs_prev_term_id = term_id


    all_terms = await db[COL_TERMS].find(
        {}, {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1}
    ).sort([("acad_year_start", 1), ("term_number", 1)]).to_list(None)    

    # ------------------------------
    # 7) Leaves
    # ------------------------------
    # 7) Leaves
    term_rank = {t["term_id"]: i for i, t in enumerate(all_terms or [])}

    # Case-insensitive "approved" + only the fields we need
    leave_rows = await db[COL_LEAVES].find(
        {"approval_status": {"$regex": r"^approved$", "$options": "i"}},
        {"_id": 0, "faculty_id": 1, "start_term_id": 1, "end_term_id": 1}
    ).to_list(None)

    blocked = set()
    cur_rank = term_rank.get(term_id, None)
    if cur_rank is not None:
        for lv in leave_rows or []:
            fid = lv.get("faculty_id")
            st  = lv.get("start_term_id")
            et  = lv.get("end_term_id")
            if not fid:
                continue
            st_r = term_rank.get(st) if st else None
            et_r = term_rank.get(et) if et else None

            # start..∞
            if st_r is not None and et_r is None and cur_rank >= st_r:
                blocked.add(fid); continue
            # -∞..end
            if st_r is None and et_r is not None and cur_rank <= et_r:
                blocked.add(fid); continue
            # bounded [st..et]
            if st_r is not None and et_r is not None and st_r <= cur_rank <= et_r:
                blocked.add(fid)

    # Fallback: also respect prefs.leave_data (union into blocked)
    for fid, pref in (prefs_by_faculty or {}).items():
        ld = pref.get("leave_data") or {}
        st = ld.get("start_term_id"); et = ld.get("end_term_id")
        st_r = term_rank.get(st) if st else None
        et_r = term_rank.get(et) if et else None
        if cur_rank is None:
            continue
        if st_r is not None and et_r is None and cur_rank >= st_r:
            blocked.add(fid); continue
        if st_r is None and et_r is not None and cur_rank <= et_r:
            blocked.add(fid); continue
        if st_r is not None and et_r is not None and st_r <= cur_rank <= et_r:
            blocked.add(fid)

    # ------------------------------
    # 8) Assemble Context
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
    ctx.kacs = ctx_kacs                          # type: ignore[attr-defined]
    ctx.course_to_kacs = course_to_kacs          # type: ignore[attr-defined]
    ctx.leave_blocked = blocked
    ctx.pref_windows_quality = debug_pref_windows  # type: ignore[attr-defined]
    ctx.campus_blocked = campus_blocked
    print("phase0_load → leave_rows:", len(leave_rows), "blocked:", len(blocked), "has FAC0002:", "FAC0002" in blocked)  # debug
    
    # Build exclusion sets
    all_fids = {f["faculty_id"] for f in ctx.faculty}
    no_pref_fids = all_fids - set((ctx.prefs_by_faculty or {}).keys())
    blocked_fids = set(ctx.leave_blocked or set())

    # Final eligible faculty = has prefs AND not on leave
    eligible = [f for f in ctx.faculty
                if f["faculty_id"] not in no_pref_fids
                and f["faculty_id"] not in blocked_fids]

    # ------------------------------
    # 6) Teaching history — optimized (no term cap; include archived)
    #     • Faculty: only those in this run’s eligible pool
    #     • Courses: only those that actually appear this term
    #     • lineage: faculty_assignments(faculty_id, section_id) → sections(section_id→course_id)
    # ------------------------------
    eligible_fids = [f["faculty_id"] for f in (ctx.faculty or []) if f.get("faculty_id")]
    candidate_cids = sorted({s["course_id"] for s in (ctx.sections or []) if s.get("course_id")})

    history_map: dict[tuple[str, str], int] = {}
    hist_by_course: dict[str, int] = {}

    if eligible_fids and candidate_cids:
        # 1) fetch assignments for eligible faculty (include archived, no term filter)
        asg_rows = await db[COL_ASSIGN].find(
            {"faculty_id": {"$in": eligible_fids}},
            {"_id": 0, "faculty_id": 1, "section_id": 1}
        ).to_list(None)

        # 2) join to sections to recover course_id
        section_ids = sorted({r["section_id"] for r in (asg_rows or []) if r.get("section_id")})
        if section_ids:
            sec_rows = await db[COL_SECTIONS].find(
                {"section_id": {"$in": section_ids}},
                {"_id": 0, "section_id": 1, "course_id": 1}
            ).to_list(None)
            sec_to_course = {
                s["section_id"]: s.get("course_id")
                for s in (sec_rows or [])
                if s.get("section_id") and s.get("course_id")
            }

            # 3) tally counts only for candidate courses (keeps it relevant)
            for r in (asg_rows or []):
                fid = r.get("faculty_id")
                sid = r.get("section_id")
                cid = sec_to_course.get(sid)
                if not fid or not cid:
                    continue
                if cid not in candidate_cids:
                    continue
                history_map[(fid, cid)] = history_map.get((fid, cid), 0) + 1
                hist_by_course[cid] = hist_by_course.get(cid, 0) + 1

    # 4) attach to context (consumed by Phases 3–5 and 6A)
    ctx.history_map = history_map          # type: ignore[attr-defined]
    ctx.hist_by_course = hist_by_course    # type: ignore[attr-defined]
       
    # Attach for debugging/visibility
    ctx.excluded_no_prefs = no_pref_fids
    ctx.excluded_leave = blocked_fids

    # Replace the pool used by downstream phases (B/6A/6B)
    ctx.faculty = eligible

    print("[phase0] faculty:", len(all_fids),
        "eligible:", len(eligible),
        "no_prefs:", len(no_pref_fids),
        "on_leave:", len(blocked_fids))
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

def _enforce_global_caps(ctx: ContextA, assignments: list[dict]) -> tuple[list[dict], dict[str, int]]:
    """
    Walk assignments in order and keep only those that still fit within each faculty's
    remaining capacity. Anything beyond the faculty's cap is dropped.
    Returns (kept_assignments, used_units_by_faculty).
    """
    caps = _faculty_capacities(ctx)          # per-faculty hard cap (preferred or default)
    used: dict[str, int] = {fid: 0 for fid in caps}  # how many units we have allocated so far
    kept: list[dict] = []

    # DEBUG: snapshot of incoming assignments
    print(
        "[CAP_ENFORCE_IMPL] incoming:",
        [(a.get("section_id"), a.get("faculty_id"), a.get("course_id"))
         for a in assignments if a.get("faculty_id")]
    )
    print("[CAP_ENFORCE_IMPL] caps:", caps)

    for a in assignments:
        fid = a.get("faculty_id")
        cid = a.get("course_id")
        sid = a.get("section_id")
        if not fid or not cid:
            continue
        units = int((ctx.courses.get(cid) or {}).get("units") or 0)

        # skip if no capacity info for this faculty (or zero cap)
        cap = int(caps.get(fid, 0))
        if cap <= 0:
            print(
                f"[CAP_ENFORCE_IMPL] skip sid={sid} fid={fid} cid={cid} "
                f"because cap={cap}"
            )
            continue

        before = used.get(fid, 0)

        # keep only if this assignment still fits
        if before + units <= cap:
            kept.append(a)
            used[fid] = before + units
        else:
            # DEBUG: this is the important part – what exactly gets dropped?
            print(
                f"[CAP_ENFORCE_DROP] fid={fid} dropping sid={sid} cid={cid} "
                f"units={units} used_before={before} cap={cap}"
            )

    print("[CAP_ENFORCE_IMPL] final_used:", used)
    return kept, used

def _campus_compat_pref(fpref: dict, section_campus_id: str) -> bool:
    """
    Campus compatibility comes from faculty_preferences.mode.campus_id (array).
    Empty list = no restriction (compatible with any campus).
    """
    campus_list = ((fpref.get("mode") or {}).get("campus_id") 
                   or fpref.get("campus_id") or [])
    if not campus_list:
        return True
    sid = (section_campus_id or "").strip().upper()
    return sid in {str(x).strip().upper() for x in campus_list}

def _mode_compat_pref(fpref: dict, section_mode: str | None) -> bool:
    """
    Mode compatibility comes from faculty_preferences.mode.mode.
    HYB = wildcard; FOL/ONLINE accept ONLINE/HYB; ONSITE accepts ONSITE/HYB.
    Empty = no restriction.
    """
    pref = str(((fpref.get("mode") or {}).get("mode") 
               or fpref.get("preferred_mode") or "")).strip().upper()
    if not pref:
        return True
    m = (section_mode or "HYB").strip().upper()
    if pref == "HYB":
        return True
    if pref in ("FOL", "ONLINE"):
        return m in ("ONLINE", "HYB")
    if pref == "ONSITE":
        return m in ("ONSITE", "HYB")
    return True

# ---------------------- TIME / OVERLAP HELPERS (Phase 6B) ----------------------
_DAY_MAP = {
    "M": 1, "T": 2, "W": 3, "H": 4, "TH": 4, "F": 5, "S": 6, "U": 7,
    1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7
}

def _to_min(hhmm: str | int | None) -> int:
    if hhmm is None or hhmm == "": return -1
    s = str(hhmm).strip()
    if ":" in s:
        try:
            hh, mm = s.split(":")
            return int(hh) * 60 + int(mm)
        except Exception:
            return -1
    # remove non-digits, then zfill(4) for 3-digit inputs like "915"
    import re as _re
    digits = _re.sub(r"\D", "", s)
    if not digits:
        return -1
    if len(digits) == 3:
        digits = "0" + digits
    if len(digits) == 4:
        try:
            return int(digits[:2]) * 60 + int(digits[2:])
        except Exception:
            return -1
    return -1

def _conflict(a: tuple[int, int], b: tuple[int, int]) -> bool:
    """(start, end) in minutes; treat empty as non-conflicting."""
    sa, ea = a; sb, eb = b
    if min(sa, ea, sb, eb) < 0: return False
    return not (ea <= sb or eb <= sa)

def _mm_to_hhmm(m: int) -> str:
    if m is None or m < 0: return ""
    h = m // 60
    mm = m % 60
    return f"{h:02d}:{mm:02d}"

MAX_CONSEC_TEACH_MIN = 4 * 60 + 30   # 4.5 hours
MAX_GAP_FOR_STREAK   = 15            # minutes between classes still counted in a streak


def _streak_ok_for_day(
    existing: list[tuple[int, int]],
    new_slots: list[tuple[int, int]],
    max_minutes: int = MAX_CONSEC_TEACH_MIN,
    gap_tol: int = MAX_GAP_FOR_STREAK,
) -> bool:
    """
    Ensure that, on a single day, the total length of a 'teaching streak'
    (blocks separated by <= gap_tol minutes) never exceeds max_minutes.

    Example:
      07:30–09:00, 09:15–10:45, 11:00–12:30 on the same day
      → 3 x 90min = 270min teaching in a 5h window → REJECT when max_minutes=270.
    """
    intervals = [(s, e) for (s, e) in (existing + new_slots) if s >= 0 and e > s]
    if not intervals:
        return True

    intervals.sort()  # by start time
    streak_start, streak_end = intervals[0]
    streak_teach = streak_end - streak_start

    for st, en in intervals[1:]:
        gap = st - streak_end
        dur = en - st

        if gap <= gap_tol:
            # extend current streak
            streak_end = en
            streak_teach += dur
        else:
            # start a new streak
            streak_start, streak_end = st, en
            streak_teach = dur

        if streak_teach > max_minutes:
            return False

    return True

def _slots_from_scheds(scheds: list[dict]) -> list[tuple[int, tuple[int,int]]]:
    """
    Return [(day_int, (start_min, end_min)), ...] for all entries in scheds.
    Accepts either {day:'M', start_time:'07:30', end_time:'09:00', ...} shaped docs.
    """
    out = []
    for s in scheds or []:
        d_raw = s.get("day") or s.get("day_of_week") or s.get("day1") or s.get("day2") or ""
        # normalize TH/H
        d = str(d_raw).strip().upper()
        if d == "TH": d = "H"
        di = _DAY_MAP.get(d, _DAY_MAP.get(d[:1], -1))
        st = _to_min(s.get("start_time") or s.get("begin") or s.get("begin1") or s.get("start"))
        en = _to_min(s.get("end_time")   or s.get("end")   or s.get("end1")   or s.get("finish"))
        if di in _DAY_MAP.values():
            out.append((di, (st, en)))
    return out

def _to_compact_hhmm(hhmm: str) -> str:
    """'07:30' → '730', '09:15' → '915'."""
    m = _to_min(hhmm)         
    if m < 0: 
        return ""
    h, mm = divmod(m, 60)
    return f"{h}{mm:02d}"

# ------------------------------------------------------------------------------

# ---------------------- FACULTY OCCUPIED GRID + PREFS -------------------------
def _build_faculty_grid(
    ctx: ContextA,
    tentative: list[dict],
) -> dict[str, dict[int, list[tuple[int,int]]]]:
    """
    Returns: { faculty_id: { day_int: [(start,end), ...] } } using:
      • existing normalized schedules_by_section
      • tentative Phase 6A assignments (using those same schedules)
    """
    grid: dict[str, dict[int, list[tuple[int,int]]]] = {}

    # seed with current (already-known) loads if you keep them in ctx later; for now, only tentative
    for a in tentative:
        fid = a.get("faculty_id"); sid = a.get("section_id")
        if not fid or not sid: continue
        slots = _slots_from_scheds((ctx.schedules_by_section or {}).get(sid, []))
        for di, interval in slots:
            grid.setdefault(fid, {}).setdefault(di, []).append(interval)

    # normalize + coalesce intervals per day for quick checks
    for fid, days in grid.items():
        for di, arr in days.items():
            arr.sort()
            merged: list[tuple[int,int]] = []
            for st, en in arr:
                if not merged or merged[-1][1] <= st:
                    merged.append((st, en))
                else:
                    last_st, last_en = merged[-1]
                    merged[-1] = (last_st, max(last_en, en))
            days[di] = merged
    return grid

def _pref_accepts_slot(fpref: dict, di: int, interval: tuple[int,int]) -> bool:
    """
    Accept if:
      - no prefs set, OR
      - day allowed AND any preferred time window overlaps.

    Supports preferred_times entries shaped as:
      • {"start":"07:30","end":"12:00"} / {"begin":"0730","finish":"1200"}
      • ["07:30","12:00"] or ("0730","1200")
      • "915-1045" / "7:30-9:00"
      • buckets: "AM","PM","MORNING","AFTERNOON","EVENING","NIGHT"
    """
    if not isinstance(fpref, dict):
        return True  # defensive: bad shape → accept

    # --- day filtering ---
    days = fpref.get("availability_days") or []
    if days:
        dset = set()
        for d in days:
            s = str(d).strip().upper()
            if s == "TH": s = "H"
            di_norm = _DAY_MAP.get(s, _DAY_MAP.get(s[:1], -1))
            if di_norm > 0:
                dset.add(di_norm)
        if di not in dset:
            return False

    # --- time windows ---
    times = fpref.get("preferred_times")
    if not times:
        return True  # no time prefs → accept

    def _parse_time_window(t):
        # dict form
        if isinstance(t, dict):
            st = _to_min(t.get("start") or t.get("begin"))
            en = _to_min(t.get("end")   or t.get("finish"))
            return (st, en) if st >= 0 and en >= 0 else None
        # list/tuple form
        if isinstance(t, (list, tuple)) and len(t) == 2:
            st = _to_min(t[0]); en = _to_min(t[1])
            return (st, en) if st >= 0 and en >= 0 else None
        # string form
        if isinstance(t, str):
            s = t.strip().upper().replace("\u2013", "-").replace("\u2014", "-")
            # bucket keywords
            buckets = {
                "AM": (0, 12*60),
                "PM": (12*60, 24*60),
                "MORNING": (6*60, 12*60),
                "AFTERNOON": (12*60, 18*60),
                "EVENING": (17*60, 21*60),
                "NIGHT": (21*60, 24*60),
            }
            if s in buckets:
                return buckets[s]
            # "HH:MM-HH:MM" or "HHMM-HHMM" or "H:MM-H:MM" etc.
            if "-" in s:
                a, b = s.split("-", 1)
                st = _to_min(a); en = _to_min(b)
                return (st, en) if st >= 0 and en >= 0 else None
        return None

    # accept if ANY window overlaps the section interval
    seq = times if isinstance(times, list) else [times]
    accepted = False
    for t in seq:
        win = _parse_time_window(t)
        if not win:
            # unknown shape → skip (lenient)
            continue
        if _conflict(win, interval):
            accepted = True
            break

    # if we had explicit windows but none overlapped, reject
    return accepted
# ------------------------------------------------------------------------------

# --- IDs / normalize helpers (place near _fmt_time / _mm_to_hhmm) ---
def _sched_id(section_id: str, ordinal: int) -> str:
    # SEC0001 -> SCH0001-01, SCH0001-02
    tail = (section_id or "").replace("SEC", "")
    return f"SCH{tail}-{ordinal:02d}"

def _norm_hhmm(s: str | None) -> str:
    return _fmt_time(s)  # reuse your tolerant formatter

# ------------------------------ PHASE 5 ------------------------------
def _coordinator_for_course(ctx: ContextA, cid: str) -> list[str]:
    c = (ctx.courses or {}).get(cid) or {}
    raw = c.get("course_coordinator") or c.get("coordinator_faculty_id") or c.get("coordinator")
    if not raw:
        return []

    vals = raw if isinstance(raw, list) else [raw]
    # build user_id -> faculty_id map
    uid_to_fid = {f.get("user_id"): f.get("faculty_id") for f in ctx.faculty if f.get("user_id") and f.get("faculty_id")}
    out: list[str] = []
    for v in vals:
        if not isinstance(v, str) or not v:
            continue
        if v.startswith("USR"):           # looks like user_id
            fid = uid_to_fid.get(v)
            if fid:
                out.append(fid)
        else:
            out.append(v)                 # assume already a faculty_id
    # unique, preserve order
    seen = set(); ret = []
    for fid in out:
        if fid and fid not in seen:
            seen.add(fid); ret.append(fid)
    return ret

def _compute_topk_for_course(by_course: dict, cid: str, candidates: list[dict], max_topk: int = 5) -> list[str]:
    """
    Phase 5: Dynamic Top-K = min(max_topk, #sections under the course, #candidates), at least 1.
    Returns faculty_ids from the *ranked* candidates list.
    """
    n_sections = len((by_course.get(cid) or {}).get("sections", []))
    k = max(1, min(max_topk, n_sections, len(candidates)))
    return [c["faculty_id"] for c in candidates[:k]]

def _effective_kacs_for_faculty(ctx: ContextA, f: dict) -> set[str]:
    """
    Return the union of a faculty’s preferred and qualified KACs.
    Used for solo-KAC detection.
    """
    fid = f.get("faculty_id")
    prefs = set((ctx.prefs_by_faculty.get(fid) or {}).get("preferred_kacs") or [])
    qual = set(f.get("qualified_kacs") or f.get("kac_ids") or [])
    return prefs | qual

def _apply_protection_tags(by_course: dict, cid: str, coord_ids: list[str], topk_ids: list[str]) -> None:
    """
    Phase 5: Tag protected faculty for this course.
    Structure: by_course[cid]["protection_tags"] = { faculty_id: ["coordinator","topK", ...] }
    Handles both list and set types safely.
    """
    tags = (by_course.setdefault(cid, {})).setdefault("protection_tags", {})

    def _as_set(x):
        if isinstance(x, set):
            return x
        if isinstance(x, list):
            return set(x)
        return set()

    # add coordinator tags
    for fid in coord_ids or []:
        cur = _as_set(tags.get(fid))
        cur.add("coordinator")
        tags[fid] = cur

    # add Top-K tags
    for fid in topk_ids or []:
        cur = _as_set(tags.get(fid))
        cur.add("topK")
        tags[fid] = cur

    # normalize sets → lists for JSON safety
    by_course[cid]["protection_tags"] = {fid: sorted(list(_as_set(v))) for fid, v in tags.items()}

def _apply_solo_kac_tags(ctx: ContextA, by_course: dict, cid: str, candidates: list[dict], course_kacs: set[str]) -> None:
    """
    Phase 5: If a candidate has exactly one effective KAC and that KAC is in this course's KACs,
    tag them as 'soloKAC' so later phases can protect/prioritize them for this KAC.
    """
    if not course_kacs:
        return
    tags = (by_course.setdefault(cid, {})).setdefault("protection_tags", {})
    for c in candidates:
        fid = c.get("faculty_id")
        if not fid:
            continue
        # pull the original faculty/profile doc from ctx
        fdoc = next((x for x in ctx.faculty if x.get("faculty_id") == fid), None)
        if not fdoc:
            continue
        eff = _effective_kacs_for_faculty(ctx, fdoc)
        if len(eff) == 1:
            sk = next(iter(eff))
            if sk in course_kacs:
                tags.setdefault(fid, set()).add("soloKAC")
    # normalize sets → lists
    by_course[cid]["protection_tags"] = {fid: sorted(list(v)) for fid, v in tags.items()}
# --------------------------- END PHASE 5 -----------------------------

async def _room_type_from_row(r: dict, ordn: int, db=None) -> str | None:
    """
    Determine room_type for section_schedules based on section + course mode rules.
    Rules:
      - If section['mode'] == 'HYB':
          * CMPS0001 campus: Room 1 = Online (room_id null)
            Room 2 = if no room_id yet, use course.room_type as temp display value
          * CMPS0002 campus: reverse logic (Online for Room 2)
      - If section['mode'] == 'FOL':
          * Both Room 1 and Room 2 = Online (room_id null)
    """
    sid = r.get("section_id") or r.get("id")
    if not sid or not db:
        return None

    # Fetch section to get mode and campus
    section = await db["sections"].find_one({"section_id": sid}, {"_id": 0, "mode": 1, "campus_id": 1, "course_id": 1})
    if not section:
        return None

    mode = (str(r.get("mode") or "").upper() or str(section.get("mode") or "").upper())
    campus_id = section.get("campus_id")
    course_id = section.get("course_id")

    # Fetch course to get its room_type
    course = await db["courses"].find_one({"course_id": course_id}, {"_id": 0, "room_type": 1})
    course_room_type = (course or {}).get("room_type") or "Online"

    # --- Logic ---
    if mode == "HYB":
        # CMPS0001 campus
        if campus_id == "CMPS0001":
            if ordn == 1:
                return "Online"
            else:
                return course_room_type  # fallback room type for display
        # CMPS0002 campus
        elif campus_id == "CMPS0002":
            if ordn == 1:
                return course_room_type
            else:
                return "Online"

    elif mode == "FOL":
        return "Online"

    # No mode decided → do not set a room_type
    return None

# =============  MILESTONE C — Phase 6A (Capacity-first matching; no time/day)  =============
# Goal: iterate in KAC→course order, and for each course exhaust the top faculty's
# remaining units on its sections before moving to the next faculty (time/day ignored for now).

def _section_units(ctx: ContextA, cid: str) -> int:
    # prefer course units; fallback to 3
    return int((ctx.courses.get(cid) or {}).get("units") or 3)

def _course_sections(ctx: ContextA, by_course: dict, cid: str) -> list[str]:
    # preserve stable section order within a course
    return list(by_course.get(cid, {}).get("sections", []))

def _promote_protected_first(by_course: dict, cid: str, cand_list: list[dict]) -> list[dict]:
    """
    Phase 6A: Promote protected candidates:
      1) coordinators, then
      2) soloKAC,
    preserving relative order inside each bucket and overall stability.
    """
    tags = (by_course.get(cid, {}).get("protection_tags", {})) or {}
    def has(fid: str, tag: str) -> bool:
        return tag in (tags.get(fid) or [])
    coords, solos, others = [], [], []
    for c in cand_list:
        fid = c.get("faculty_id")
        if fid and has(fid, "coordinator"):
            coords.append(c)
        elif fid and has(fid, "soloKAC"):
            solos.append(c)
        else:
            others.append(c)
    return coords + solos + others

async def run_milestone_c_phase6a(term_id: str, db, department_id: str | None = None) -> dict:
    """
    Phase 6A: capacity-first, campus/mode-ready (already gated in Phase 5),
    NO time/day checking yet. Produces a list of tentative assignments.
    """

    # Rebuild context + ordering (reuse A/3 logic) and reuse B to get candidates
    ctx = await phase0_load(term_id, db, department_id)
    print("6A ctx.leave_blocked:", len(getattr(ctx, "leave_blocked", set()) or set()),
          "has FAC0002:", "FAC0002" in (getattr(ctx, "leave_blocked", set()) or set()))  # <-- ADD
    phase1_kac_helpers(ctx)
    phase3_kac_prioritization(ctx)

    # Build Phase 5 pools (call B once to avoid duplicating candidate logic)
    phase5 = await run_milestone_b(term_id, db, department_id)
    by_course = phase5.get("by_course", {})
    course_order = phase5.get("courses_order", []) or (ctx.course_order or [])

    # --- NEW: Enforce primary pass order: Foundation → SHS → others ---
    def _ctype_of(cid: str) -> str:
        c = (ctx.courses.get(cid) or {})
        t = (c.get("type") or c.get("type_of_course") or "Major")
        return str(t).strip().upper()

    buckets = {"FOUNDATION": [], "SHS": [], "OTHER": []}
    for cid in course_order:
        ct = _ctype_of(cid)
        if ct == "FOUNDATION":
            buckets["FOUNDATION"].append(cid)
        elif ct == "SHS":
            buckets["SHS"].append(cid)
        else:
            buckets["OTHER"].append(cid)

    # Final processing order
    course_order = buckets["FOUNDATION"] + buckets["SHS"] + buckets["OTHER"]

    # ----- Phase 6A KAC coverage bookkeeping (prioritize higher KACs) -----
    # total sections per KAC (from phase3 kac_stats), and per-KAC assigned so far
    kac_total_sections: dict[str, int] = {}
    kac_assigned: dict[str, int] = {}

    campus2_total = sum(1 for s in ctx.sections if (s.get("campus_id") or "").strip().upper() == "CMPS0002")
    campus2_assigned = 0

    # build course -> primary KAC map (choose the first KAC if multiple)
    course_to_primary_kac: dict[str, str] = {}
    for cid2 in course_order:
        kset = (getattr(ctx, "course_to_kacs", {}) or {}).get(cid2) or set()
        if kset:
            course_to_primary_kac[cid2] = next(iter(sorted(kset)))  # stable pick
    # fill totals from ctx.kac_stats if available
    for kid, ks in (getattr(ctx, "kac_stats", {}) or {}).items():
        kac_total_sections[kid] = int(ks.get("sections") or 0)
        kac_assigned[kid] = 0


    # capacities (preferred_units → remaining_units → default)
    caps = _faculty_capacities(ctx)
    caps_baseline = dict(caps)

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
        cand_list = _promote_protected_first(by_course, cid, cand_list)

        # Precompute solo-KAC ownership for each faculty (for quick lookup)
        solo_kac_of_faculty: dict[str, str] = {}
        for course_id, info in by_course.items():
            tags = (info or {}).get("protection_tags", {}) or {}
            for fid_tag, taglist in tags.items():
                if "soloKAC" in (taglist or []) and fid_tag not in solo_kac_of_faculty:
                    solo_kac_of_faculty[fid_tag] = course_to_primary_kac.get(course_id)

        # --- NEW: local helper to enforce solo-CMPS0002 reservation until coverage ---
        def _campus2_reservation_allows(fid: str, section_campus_id: str) -> bool:
            # allow if the section is CMPS0002
            if (section_campus_id or "").strip().upper() == "CMPS0002":
                return True
            # if faculty is not solo-CMPS0002, no reservation applies
            fpref = (ctx.prefs_by_faculty.get(fid) or {})
            campus_list = ((fpref.get("mode") or {}).get("campus_id") or [])
            solo = {str(x).strip().upper() for x in campus_list if x} == {"CMPS0002"}
            if not solo:
                return True
            # solo-CMPS0002 must be preserved for CMPS0002 until ~80% coverage
            if campus2_total <= 0:
                return True
            if (section_campus_id or "").strip().upper() != "CMPS0002" and solo:
                return False
            return True

        # exhaust top candidate's units across the course before moving to next
        for c in cand_list:
            fid = c.get("faculty_id")
            if not fid:
                continue

            # NEW: hard guard — never assign someone on leave
            if fid in (getattr(ctx, "leave_blocked", set()) or set()):
                continue

            # NEW: hard guard — never assign someone on leave
            if fid in (getattr(ctx, "leave_blocked", set()) or set()):
                continue

            cap = int(caps.get(fid, 0))
            if cap < units_per_sec:
                continue

            # --- solo-KAC guard (reserve for their own KAC until covered) ---
            solo_kac_id = solo_kac_of_faculty.get(fid)

            current_kac = course_to_primary_kac.get(cid)
            if solo_kac_id and current_kac != solo_kac_id:
                total = int(kac_total_sections.get(solo_kac_id, 0))
                done  = int(kac_assigned.get(solo_kac_id, 0))
                # threshold (e.g., 80%): allow spillover after coverage ratio is reached
                SOLO_KAC_RELEASE_RATIO = 0.80
                if total > 0:
                    covered = (done / total) >= SOLO_KAC_RELEASE_RATIO
                    if not covered:
                        continue

            # Assign as many unassigned sections of this course as capacity allows
            i = 0
            while i < len(sec_ids) and cap >= units_per_sec:
                sid = sec_ids[i]
                if sid in assigned:
                    i += 1
                    continue

                # --- NEW: reservation guard before committing ---
                sec = next((x for x in ctx.sections if x.get("section_id") == sid), {}) or {}
                sec_campus = (sec.get("campus_id") or "").strip().upper()
                fpref_local = (ctx.prefs_by_faculty.get(fid) or {})
                # campus check (strict, using THIS section’s campus)
                if not _campus_compat_pref(fpref_local, sec_campus):
                    i += 1
                    continue
                # mode check (use the section’s declared mode; default HYB if unset)
                sec_mode = (sec.get("mode") or "HYB")
                if not _mode_compat_pref(fpref_local, sec_mode):
                    i += 1
                    continue

                # (Phase 6A skips time/day; campus/mode already gated in Phase 5)
                assigned[sid] = {
                    "section_id": sid,
                    "course_id": cid,
                    "faculty_id": fid,
                    "faculty": c.get("name", ""),
                    "status": "Pending",
                }
                cap -= units_per_sec
                caps[fid] = cap
                per_course_assigned[cid] = per_course_assigned.get(cid, 0) + 1

                # ---- KAC coverage++ for the course's primary KAC  ----
                pk = course_to_primary_kac.get(cid)
                if pk:
                    kac_assigned[pk] = kac_assigned.get(pk, 0) + 1

                # --- NEW: campus2 coverage++ when applicable ---
                if sec_campus == "CMPS0002":
                    campus2_assigned += 1
                # -------------------------------------------------

                i += 1

            # refresh remaining unassigned list for this course (important!)
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

    # compute used units per faculty
    faculty_units = {}
    for a in assignments:
        fid = a.get("faculty_id")
        if not fid:
            continue
        units = (ctx.courses.get(a.get("course_id"), {}).get("units") or 0)
        faculty_units[fid] = faculty_units.get(fid, 0) + int(units)

    # compute each faculty's preferred cap
    preferred_cap = {}
    for fid in caps.keys():
        pref_doc = (ctx.prefs_by_faculty or {}).get(fid, {})
        preferred_cap[fid] = (
            pref_doc.get("preferred_units")
            or pref_doc.get("load_units")
            or 12
        )

    phase6a_used_units = {}
    for a in assignments:
        fid = a.get("faculty_id")
        units = int((ctx.courses.get(a.get("course_id"), {}) or {}).get("units") or 0)
        phase6a_used_units[fid] = phase6a_used_units.get(fid, 0) + units

    base_cap_map = _faculty_capacities(ctx).copy()

    debug6a = {
        "phase6a_assigned_total": len(assignments),
        "phase6a_per_course": per_course_assigned,
        "phase6a_per_kac": {k: {"assigned": int(kac_assigned.get(k, 0)), "total": int(kac_total_sections.get(k, 0))}
                            for k in sorted(set(kac_total_sections) | set(kac_assigned))},
        "phase6a_used_units": {fid: int(u) for fid, u in phase6a_used_units.items()},
        "phase6a_preferred_units": {
            fid: int(preferred_cap.get(fid, 12))
            for fid in caps.keys()
        },
        "phase6a_caps_left": {
            fid: f"{int(phase6a_used_units.get(fid, 0))}/{int(preferred_cap.get(fid, 12))}"
            for fid in caps.keys()
        },
        "phase6a_faculty_debug": phase6a_faculty_debug,
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

# =============  MILESTONE D — Phase 6B (Feasibility + Minimal Reshuffle)  =============
async def run_milestone_d_phase6b(term_id: str, db, department_id: str | None = None) -> dict:
    """
    Build on Phase 6A: validate time/day feasibility against:
      • section_schedules
      • faculty availability_days / preferred_times
    Keep feasible, try minimal reshuffle for conflicts (same-course candidates first),
    then mark leftovers as 'Conflict'.
    """
    # 1) Run 6A to get tentative picks + candidate pools
    res6a = await run_milestone_c_phase6a(term_id, db, department_id)
    assignments = list(res6a.get("assignments", []))
    by_course = dict(res6a.get("by_course", {}))

    # 2) Rebuild context to read schedules/prefs quickly
    ctx = await phase0_load(term_id, db, department_id)
    print("6B ctx.leave_blocked:", len(getattr(ctx, "leave_blocked", set()) or set()),
          "has FAC0002:", "FAC0002" in (getattr(ctx, "leave_blocked", set()) or set()))

    # 3) Prepare grids & quick lookups
    fac_pref = ctx.prefs_by_faculty or {}
    grid = _build_faculty_grid(ctx, assignments)
    caps_after_6a = {}  # we’ll reconstruct remaining units from 6A debug
    for fdbg in (res6a.get("debug", {}) or {}).get("phase6a_faculty_debug", []):
        caps_after_6a[fdbg["faculty_id"]] = int(fdbg.get("remaining_units", 0))

    section_course = {s["section_id"]: s["course_id"] for s in ctx.sections}
    feasible: list[dict] = []
    conflicts: list[dict] = []

    # helper to test if (fid, sid) is sched-feasible & pref-accepted
    def _is_ok(fid: str, sid: str) -> bool:
        slots = _slots_from_scheds((ctx.schedules_by_section or {}).get(sid, []))
        if not slots:
            return True  # no schedule registered → treat as okay

        for di, itv in slots:
            # 1) preference acceptance
            if not _pref_accepts_slot(fac_pref.get(fid, {}), di, itv):
                return False

            existing = grid.get(fid, {}).get(di, [])

            # 2) hard conflict with existing intervals
            for cur in existing:
                if _conflict(cur, itv):
                    return False

            # 3) 4.5h consecutive-teaching rule
            if not _streak_ok_for_day(existing, [itv]):
                return False

        return True


    # 4) First pass: keep feasible, collect conflict pool
    for a in assignments:
        fid, sid = a["faculty_id"], a["section_id"]
        if _is_ok(fid, sid):
            feasible.append(a)
        else:
            conflicts.append(a)

    # 5) Minimal reshuffle: try to reassign each conflict using Phase 5 pool
    #    Priority: same-course candidates, keep protection order via _promote_protected_first
    reassigned: list[dict] = []
    unresolved: list[dict] = []
    for a in conflicts:
        sid = a["section_id"]; cid = a["course_id"]
        cinfo = by_course.get(cid, {})
        cand_list = list(cinfo.get("candidates", []))
        cand_list = _promote_protected_first(by_course, cid, cand_list)

        units = int((ctx.courses.get(cid) or {}).get("units") or 3)
        found = None
        for c in cand_list:
            fid2 = c.get("faculty_id")
            if not fid2: 
                continue
            if fid2 == a["faculty_id"]:
                continue

            # NEW: also respect leave here
            if fid2 in (getattr(ctx, "leave_blocked", set()) or set()):
                continue

            if int(caps_after_6a.get(fid2, 0)) < units:
                continue
            if not _is_ok(fid2, sid):
                continue
            # OK → assign to fid2
            
            found = {
                **a,
                "faculty_id": fid2,
                "faculty": c.get("name", a.get("faculty", "")),
                "status": "Pending",
            }
            # update grid & caps
            slots = _slots_from_scheds((ctx.schedules_by_section or {}).get(sid, []))
            for di, itv in slots:
                grid.setdefault(fid2, {}).setdefault(di, []).append(itv)
            caps_after_6a[fid2] = int(caps_after_6a.get(fid2, 0)) - units
            break

        if found:
            reassigned.append(found)
        else:
            unresolved.append(a)

    # 6) Finalize results
    #    - keep original feasible
    #    - replace conflicted with reassigned where found
    #    - mark unresolved as Conflict (with light note)
    final_assignments = []
    assigned_sids = set()
    for a in feasible + reassigned:
        final_assignments.append(a)
        assigned_sids.add(a["section_id"])
    for a in unresolved:
        if a["section_id"] in assigned_sids:
            continue
        final_assignments.append({**a, "status": "Conflict", "conflictNote": "Time/day clash or pref mismatch"})

    # Debug payload
    debug6b = {
        "phase6b_kept": len(feasible),
        "phase6b_reassigned": len(reassigned),
        "phase6b_unresolved": len(unresolved),
        "phase6b_unresolved_sections": [a["section_id"] for a in unresolved],
    }

    return {
        **res6a,
        "assignments": final_assignments,
        "debug": {**(res6a.get("debug") or {}), **debug6b},
    }
# =============  END MILESTONE D — Phase 6B  ==========================

POLICY_ALLOW_SHS_SACRIFICE_IF_NO_CAPACITY = True

def _total_remaining_capacity(ctx, assignments) -> int:
    units = {cid: int((ctx.courses.get(cid) or {}).get("units") or 3) for cid in ctx.courses}
    caps  = _faculty_capacities(ctx)
    used  = {}
    for a in assignments:
        fid, cid = a.get("faculty_id"), a.get("course_id")
        if fid and cid:
            used[fid] = used.get(fid, 0) + units.get(cid, 3)
    rem = 0
    for fid, cap in caps.items():
        rem += max(0, cap - used.get(fid, 0))
    return rem

# =============  MILESTONE D2 — Rebalance: borrow from SHS to cover non-SHS  =============
async def run_milestone_d2_rebalance_shs_to_cover_nshs(term_id: str, db, department_id: str | None = None) -> dict:
    """
    Start from Phase 6B results, then:
      1) Find any non-SHS sections with no assignment (missing) or marked Conflict/Unassigned.
      2) Search SHS-assigned faculty for a compatible match (KAC/campus/mode + time/prefs).
      3) If compatible, move the faculty from SHS → the empty non-SHS, and release the SHS section.
      4) Optionally try to backfill the released SHS from its candidate pool.
    """
    base = await run_milestone_d_phase6b(term_id, db, department_id)
    assignments: list[dict] = list(base.get("assignments", []))

    # Rebuild context + quick lookups
    ctx = await phase0_load(term_id, db, department_id)
    by_course = dict(base.get("by_course", {})) or {}
    schedules_by_section = ctx.schedules_by_section or {}

    def _ctype(cid: str) -> str:
        c = (ctx.courses.get(cid) or {})
        t = (c.get("type") or c.get("type_of_course") or "Major")
        return str(t).strip().upper()

    # Build convenience maps
    section_to_course = {s["section_id"]: s["course_id"] for s in ctx.sections}
    assigned_by_sid = {a["section_id"]: a for a in assignments}
    all_sids = [s["section_id"] for s in ctx.sections]

    # Identify targets: non-SHS sections that are missing or unresolved
    empty_nshs: list[str] = []
    for sid in all_sids:
        cid = section_to_course.get(sid)
        if not cid or _ctype(cid) == "SHS":
            continue
        a = assigned_by_sid.get(sid)
        if not a or (a.get("status", "").lower() in ("conflict", "unassigned")):
            empty_nshs.append(sid)

    # Build pool of SHS assignees we can potentially borrow from
    shs_pool: list[dict] = []
    for a in assignments:
        cid = a.get("course_id")
        if _ctype(cid) == "SHS" and a.get("faculty_id"):
            shs_pool.append(a)

    # Helpers we already have in file
    def _is_sched_ok(fid: str, sid: str) -> bool:
        # reuse Phase 6B helpers
        slots = _slots_from_scheds(schedules_by_section.get(sid, []))
        if not slots:
            return True
        fpref = (ctx.prefs_by_faculty or {}).get(fid, {})
        # Build a faculty grid from current assignments (excluding the SHS one we might remove)
        tentative = [x for x in assignments if x.get("faculty_id") == fid and x.get("section_id") != sid]
        grid = _build_faculty_grid(ctx, tentative)
        for di, itv in slots:
            if not _pref_accepts_slot(fpref, di, itv):
                return False
            for cur in grid.get(fid, {}).get(di, []):
                if _conflict(cur, itv):
                    return False
        return True

    def _campus_mode_ok(fid: str, sid: str) -> bool:
        sec = next((x for x in ctx.sections if x["section_id"] == sid), {})
        fpref = (ctx.prefs_by_faculty or {}).get(fid, {}) or {}
        cid = section_to_course.get(sid, "")
        if not _gs_ok(ctx, fid, cid):
            return False
        return (
            _campus_compat_pref(fpref, sec.get("campus_id") or "") and
            _mode_compat_pref(fpref, sec.get("mode"))
        )

    # Rebalance loop: for each empty non-SHS, try to borrow one SHS faculty
    borrowed = []
    for sid in empty_nshs:
        cid = section_to_course.get(sid)
        if not cid:
            continue

        # Try each SHS assignee as a donor, but only if we can backfill their SHS first
        moved = False
        for shs_a in list(shs_pool):
            donor_fid = shs_a.get("faculty_id")
            shs_sid   = shs_a.get("section_id")
            if not donor_fid or not shs_sid:
                continue
            if donor_fid in (getattr(ctx, "leave_blocked", set()) or set()):
                continue
            # donor must fit the non-SHS target
            if not _campus_mode_ok(donor_fid, sid):
                continue
            # KAC guard for target
            course_kacs = set((getattr(ctx, "course_to_kacs", {}) or {}).get(cid, set()))
            if course_kacs:
                f = next((x for x in ctx.faculty if x.get("faculty_id") == donor_fid), {})
                pref_kacs = set(((ctx.prefs_by_faculty.get(donor_fid) or {}).get("preferred_kacs") or []))
                qual_kacs = set(f.get("qualified_kacs") or f.get("kac_ids") or [])
                if not (course_kacs & (pref_kacs | qual_kacs)):
                    continue
            # time feasibility for donor on target
            if not _is_sched_ok(donor_fid, sid):
                continue

            # --- Look ahead: can we backfill the SHS section (shs_sid) right now? ---
            shs_cid = section_to_course.get(shs_sid)
            cinfo = by_course.get(shs_cid, {})
            cand_list = list(cinfo.get("candidates", []))
            cand_list = _promote_protected_first(by_course, shs_cid, cand_list)
            backfill = None
            for c in cand_list:
                fid2 = c.get("faculty_id")
                if not fid2 or fid2 == donor_fid:
                    continue
                if fid2 in (getattr(ctx, "leave_blocked", set()) or set()):
                    continue
                if not _campus_mode_ok(fid2, shs_sid):
                    continue
                if not _is_sched_ok(fid2, shs_sid):
                    continue
                # KAC for SHS backfill
                shs_kacs = set((getattr(ctx, "course_to_kacs", {}) or {}).get(shs_cid, set()))
                if shs_kacs:
                    f2 = next((x for x in ctx.faculty if x.get("faculty_id") == fid2), {})
                    pk2 = set(((ctx.prefs_by_faculty.get(fid2) or {}).get("preferred_kacs") or []))
                    qk2 = set(f2.get("qualified_kacs") or f2.get("kac_ids") or [])
                    if not (shs_kacs & (pk2 | qk2)):
                        continue
                backfill = fid2
                break

            # If no backfill found, skip this donor (keep SHS intact)
            if not backfill:
                continue

            # --- Perform atomic swap: move donor to non-SHS AND assign backfill to SHS ---
            donor_name = shs_a.get("faculty", "")
            # 1) assign donor to target non-SHS
            new_a = {
                "section_id": sid,
                "course_id": cid,
                "faculty_id": donor_fid,
                "faculty": donor_name,
                "status": "Pending",
            }
            assignments = [a for a in assignments if a.get("section_id") != sid] + [new_a]

            # 2) assign backfill to the released SHS
            backfill_name = _display_name_from_users(ctx.users_by_faculty.get(backfill))
            shs_new = {
                "section_id": shs_sid,
                "course_id": shs_cid,
                "faculty_id": backfill,
                "faculty": backfill_name,
                "status": "Pending",
            }
            assignments = [a for a in assignments if a.get("section_id") != shs_sid] + [shs_new]

            # 3) update pools and logs
            shs_pool = [a for a in shs_pool if a.get("section_id") != shs_sid]  # donor removed
            borrowed.append({"from_shs": shs_sid, "to_nshs": sid, "faculty_id": donor_fid, "backfill": backfill})
            moved = True
            break  # stop scanning donors for this sid

        # go to next empty non-SHS; if not moved, it stays empty for now

    debug_d2 = {
        "d2_borrowed_count": len(borrowed),
        "d2_borrowed_pairs": borrowed,
        "d2_shs_backfilled": len([b for b in borrowed if b.get("backfill")]),
    }

    return {
        **base,
        "assignments": assignments,
        "debug": {**(base.get("debug") or {}), **debug_d2},
    }

# =============  END MILESTONE D2  =============

def _is_pt(ctx, fid: str) -> bool:
    f = next((x for x in ctx.faculty if x.get("faculty_id") == fid), {})
    return (f.get("employment_type") or "").strip().upper() == "PT"

def _is_ft(ctx, fid: str) -> bool:
    f = next((x for x in ctx.faculty if x.get("faculty_id") == fid), {})
    return (f.get("employment_type") or "").strip().upper() == "FT"

def _is_solo_campus2_pref(ctx, fid: str) -> bool:
    p = (ctx.prefs_by_faculty.get(fid) or {})
    camp = ((p.get("mode") or {}).get("campus_id") or [])
    return {str(x).strip().upper() for x in camp if x} == {"CMPS0002"}

def _mode_of_pref(ctx, fid: str) -> str:
    p = (ctx.prefs_by_faculty.get(fid) or {})
    return str(((p.get("mode") or {}).get("mode") or "")).strip().upper()

def _section_campus(ctx, sid: str) -> str:
    s = next((x for x in ctx.sections if x.get("section_id") == sid), {})
    return (s.get("campus_id") or "").strip().upper()

def _section_course(ctx, sid: str) -> str:
    s = next((x for x in ctx.sections if x.get("section_id") == sid), {})
    return s.get("course_id") or ""

def _course_requires_phd(ctx: ContextA, cid: str) -> bool:
    c = (ctx.courses.get(cid) or {})
    lvl = str(c.get("program_level") or "").strip().upper()
    return lvl == "GS"

def _has_phd_cert(ctx: ContextA, fid: str) -> bool:
    f = next((x for x in ctx.faculty if x.get("faculty_id") == fid), {})
    certs = [str(x).strip().upper() for x in (f.get("certifications") or [])]
    return "PHD" in certs

def _gs_ok(ctx: ContextA, fid: str, cid: str) -> bool:
    """
    GS courses (program_level=GS) must be taught by faculty with a PhD.
    """
    if not _course_requires_phd(ctx, cid):
        return True
    return _has_phd_cert(ctx, fid)

def _kac_ok(ctx, fid: str, cid: str) -> bool:
    # GS rule first: if the course requires PhD and faculty is not PhD → reject
    if not _gs_ok(ctx, fid, cid):
        return False

    course_kacs = set((getattr(ctx, "course_to_kacs", {}) or {}).get(cid, set()))
    if not course_kacs:
        return True
    fdoc = next((x for x in ctx.faculty if x.get("faculty_id") == fid), {})
    pref_kacs = set(((ctx.prefs_by_faculty.get(fid) or {}).get("preferred_kacs") or []))
    qual_kacs = set(fdoc.get("qualified_kacs") or fdoc.get("kac_ids") or [])
    return bool((pref_kacs | qual_kacs) & course_kacs)

def _campus_mode_ok_ctx(ctx, fid: str, sid: str) -> bool:
    sec = next((x for x in ctx.sections if x["section_id"] == sid), {})
    fpref = (ctx.prefs_by_faculty or {}).get(fid, {}) or {}
    return (
        _campus_compat_pref(fpref, sec.get("campus_id") or "") and
        _mode_compat_pref(fpref, sec.get("mode"))
    )

def _sched_ok_ctx(ctx, fid: str, sid: str, assignments: list[dict]) -> bool:
    slots = _slots_from_scheds((ctx.schedules_by_section or {}).get(sid, []))
    if not slots:
        return True
    fpref = (ctx.prefs_by_faculty or {}).get(fid, {})
    # build grid from all other assignments of this faculty
    tentative = [x for x in assignments if x.get("faculty_id") == fid and x.get("section_id") != sid]
    grid = _build_faculty_grid(ctx, tentative)

    for di, itv in slots:
        if not _pref_accepts_slot(fpref, di, itv):
            return False

        existing = grid.get(fid, {}).get(di, [])
        for cur in existing:
            if _conflict(cur, itv):
                return False

        if not _streak_ok_for_day(existing, [itv]):
            return False

    return True

def _swap_assign(assignments: list[dict], sid: str, new_fid: str, new_name: str) -> list[dict]:
    # replace or insert assignment for sid
    out = []
    replaced = False
    for a in assignments:
        if a.get("section_id") == sid:
            out.append({**a, "faculty_id": new_fid, "faculty": new_name, "status": "Pending"})
            replaced = True
        else:
            out.append(a)
    if not replaced:
        out.append({"section_id": sid, "course_id": "", "faculty_id": new_fid, "faculty": new_name, "status":"Pending"})
    return out

def run_pass_ft_reclaim_from_pt(ctx, assignments: list[dict]) -> list[dict]:
    """
    Lift under-cap FTs by reclaiming PT-held sections when feasible.
    Never evict a solo-CMPS0002 PT from a CMPS0002 section.
    Limit: at most 1 reclaim per FT.
    """
    # compute units per course once
    units = {cid: int((ctx.courses.get(cid) or {}).get("units") or 3) for cid in ctx.courses}
    # tally FT usage
    used = {}
    for a in assignments:
        fid = a.get("faculty_id"); cid = a.get("course_id")
        if fid and cid:
            used[fid] = used.get(fid, 0) + units.get(cid, 3)
    caps = _faculty_capacities(ctx)

    # PT-held sections list
    pt_sections = [a for a in assignments if a.get("faculty_id") and _is_pt(ctx, a["faculty_id"])]

    for fdoc in ctx.faculty:
        fid = fdoc.get("faculty_id") or ""
        if not fid or not _is_ft(ctx, fid):
            continue
        # skip if FT already at or above cap
        if used.get(fid, 0) >= caps.get(fid, 0):
            continue

        # try reclaim one PT-held section that fits this FT
        for a in pt_sections:
            sid = a.get("section_id"); pfid = a.get("faculty_id")
            cid = a.get("course_id")

            # protect solo-CMPS0002 PT on CMPS0002
            if _is_solo_campus2_pref(ctx, pfid) and _section_campus(ctx, sid) == "CMPS0002":
                continue

            if not _kac_ok(ctx, fid, cid):
                continue
            if not _campus_mode_ok_ctx(ctx, fid, sid):
                continue
            if not _sched_ok_ctx(ctx, fid, sid, assignments):
                continue

            # perform swap (FT takes over)
            name = _display_name_from_users(ctx.users_by_faculty.get(fid))
            assignments = _swap_assign(assignments, sid, fid, name)

            # update tallies
            used[fid] = used.get(fid, 0) + units.get(cid, 3)
            # one reclaim per FT
            break

    return assignments

def run_pass_campus_concentrate_cmps2(ctx, assignments: list[dict]) -> list[dict]:
    """
    Move CMPS0002 sections from dual-campus FTs to PT(HYB & solo-CMPS0002) or PT(FOL),
    when feasible. Limit 1 move per FT, keep protections/time/KAC/mode.
    """
    # map faculty → campuses currently held
    by_fac = {}
    for a in assignments:
        fid = a.get("faculty_id"); sid = a.get("section_id")
        if fid and sid:
            by_fac.setdefault(fid, set()).add(_section_campus(ctx, sid))

    for ft in ctx.faculty:
        fid = ft.get("faculty_id") or ""
        if not fid or not _is_ft(ctx, fid):
            continue
        campuses = by_fac.get(fid, set())
        # only consider FTs with mixed campuses
        if not ({"CMPS0001", "CMPS0002"} <= (campuses | {""}) or ("CMPS0001" in campuses and "CMPS0002" in campuses)):
            continue

        # try to move one CMPS0002 section
        for a in [x for x in assignments if x.get("faculty_id") == fid]:
            sid = a.get("section_id")
            if _section_campus(ctx, sid) != "CMPS0002":
                continue
            cid = a.get("course_id")

            # candidate PT pool: solo-CMPS0002 & HYB, or FOL (campus-agnostic)
            pt_pool = [p for p in ctx.faculty if _is_pt(ctx, p.get("faculty_id") or "")]
            pt_pool = [p for p in pt_pool
                       if (_is_solo_campus2_pref(ctx, p["faculty_id"]) and _mode_of_pref(ctx, p["faculty_id"]) == "HYB")
                       or (_mode_of_pref(ctx, p["faculty_id"]) == "FOL")]

            found = None
            for p in pt_pool:
                pfid = p["faculty_id"]
                if not _kac_ok(ctx, pfid, cid):
                    continue
                if not _campus_mode_ok_ctx(ctx, pfid, sid):
                    continue
                if not _sched_ok_ctx(ctx, pfid, sid, assignments):
                    continue
                found = pfid
                break

            if found:
                name = _display_name_from_users(ctx.users_by_faculty.get(found))
                assignments = _swap_assign(assignments, sid, found, name)
                # one move per FT
                break

    return assignments

def run_pass_rescue_non_shs(ctx, assignments: list[dict]) -> list[dict]:
    """
    After 6A/6B(+D2), if any non-SHS sections are blank:
      • try a single atomic swap: move a compatible SHS-holding faculty to the blank,
      • PREFER a safe backfill for the released SHS,
      • but if POLICY_ALLOW_SHS_SACRIFICE_IF_NO_CAPACITY and no global capacity is left,
        allow sacrificing the SHS (leave it blank) as long as donor stays within cap.

    Gates enforced: campus+mode, KAC, time/prefs, capacity.
    """
    # quick lookups
    section_to_course = {s["section_id"]: s["course_id"] for s in ctx.sections}
    assigned_by_sid = {a["section_id"]: a for a in assignments if a.get("faculty_id")}
    all_sids = [s["section_id"] for s in ctx.sections]

    def _dbg(msg: str) -> None:
        print(f"[RESCUE_NON_SHS] {msg}")

    def _ctype(cid: str) -> str:
        c = (ctx.courses.get(cid) or {})
        t = (c.get("type") or c.get("type_of_course") or "Major")
        return str(t).strip().upper()

    # units and caps
    units = {cid: int((ctx.courses.get(cid) or {}).get("units") or 3) for cid in ctx.courses}
    used: dict[str, int] = {}
    for a in assignments:
        fid, cid = a.get("faculty_id"), a.get("course_id")
        if fid and cid:
            used[fid] = used.get(fid, 0) + units.get(cid, 3)
    caps = _faculty_capacities(ctx)

    # helpers (reuse existing policy guards)
    def _can_take(fid: str, sid: str) -> bool:
        cid = section_to_course.get(sid, "")
        used_now = used.get(fid, 0)
        cap = caps.get(fid, 0)
        extra = units.get(cid, 3)

        # NOTE: these logs fire for both donors and backfillers
        if not _kac_ok(ctx, fid, cid):
            print(f"[RESCUE_CAN_TAKE] fid={fid} sid={sid} ({cid}) -> False (KAC)")
            return False
        if not _campus_mode_ok_ctx(ctx, fid, sid):
            print(f"[RESCUE_CAN_TAKE] fid={fid} sid={sid} ({cid}) -> False (campus/mode)")
            return False
        if not _sched_ok_ctx(ctx, fid, sid, assignments):
            print(f"[RESCUE_CAN_TAKE] fid={fid} sid={sid} ({cid}) -> False (schedule)")
            return False
        if used_now + extra > cap:
            print(
                f"[RESCUE_CAN_TAKE] fid={fid} sid={sid} ({cid}) -> False (capacity) "
                f"used={used_now} extra={extra} cap={cap}"
            )
            return False

        print(
            f"[RESCUE_CAN_TAKE] fid={fid} sid={sid} ({cid}) -> True "
            f"used={used_now} extra={extra} cap={cap}"
        )
        return True

    _dbg(f"assignments={len(assignments)}")
    _dbg(f"used_units={used}")
    _dbg(f"caps={caps}")
    _dbg(f"total_remaining_capacity={_total_remaining_capacity(ctx, assignments)}")

    def _swap(assignments, sid_take, fid_take, name_take, sid_release, fid_release, name_backfill):
        # assign donor to blank
        assignments = [a for a in assignments if a.get("section_id") != sid_take] + [{
            "section_id": sid_take,
            "course_id": section_to_course.get(sid_take, ""),
            "faculty_id": fid_take,
            "faculty": name_take,
            "status": "Pending",
        }]
        # backfill the released SHS
        assignments = [a for a in assignments if a.get("section_id") != sid_release] + [{
            "section_id": sid_release,
            "course_id": section_to_course.get(sid_release, ""),
            "faculty_id": fid_release,
            "faculty": name_backfill,
            "status": "Pending",
        }]
        return assignments

    # 0) Inspect all sections from the rescue pass perspective
    _dbg("scanning all sections for blanks:")
    for sid in all_sids:
        cid = section_to_course.get(sid)
        ctype = _ctype(cid) if cid else "?"
        a = assigned_by_sid.get(sid)
        fid = a.get("faculty_id") if a else None
        status = (a.get("status") if a else None) or "None"
        _dbg(f"  sid={sid} cid={cid} type={ctype} faculty_id={fid} status={status}")


    # 1) list non-SHS blanks
    blanks = []
    for sid in all_sids:
        cid = section_to_course.get(sid)
        if not cid or _ctype(cid) == "SHS":
            continue
        a = assigned_by_sid.get(sid)
        if not a or (a.get("status", "").lower() in ("unassigned", "conflict")):
            blanks.append(sid)

    _dbg(f"non-SHS blanks={[(sid, section_to_course.get(sid, '')) for sid in blanks]}")

    if not blanks:
        _dbg("no non-SHS blanks, nothing to rescue")
        return assignments

    # 2) SHS donor pool
    shs_pool = [
        a for a in assignments
        if a.get("faculty_id") and _ctype(section_to_course.get(a["section_id"])) == "SHS"
    ]
    _dbg(f"SHS donor pool={[(a.get('section_id'), a.get('faculty_id')) for a in shs_pool]}")


    # 3) fix each blank with one atomic swap
    for sid_blank in blanks:
        cid_blank = section_to_course.get(sid_blank, "")
        _dbg(f"--- Trying to rescue blank {sid_blank} ({cid_blank}) ---")

        # best: dict | None = None  # pick the “safest” option among feasible swaps
        best = None  # pick the “safest” option among feasible swaps
        for shs_a in shs_pool:
            donor_fid = shs_a.get("faculty_id")
            shs_sid   = shs_a.get("section_id")
            if not donor_fid or not shs_sid:
                continue
            if donor_fid in (getattr(ctx, "leave_blocked", set()) or set()):
                _dbg(f"skip donor {donor_fid} (leave_blocked) on SHS {shs_sid}")
                continue

            # donor must be able to take the non-SHS blank (KAC/campus/mode/time),
            # but we ignore capacity here and check net load after swap instead.
            _dbg(f"check donor {donor_fid} from SHS {shs_sid} for blank {sid_blank}")
            # donor must be able to take the non-SHS blank
            if not _can_take(donor_fid, sid_blank):
                _dbg(f"  donor {donor_fid} CANNOT take blank {sid_blank} (see RESCUE_CAN_TAKE above)")
                continue

            shs_cid = section_to_course.get(shs_sid, "")

            # --- Try to find an immediate backfill for this SHS ---
            cinfo = (getattr(ctx, "by_course_for_rescue", {}) or {}).get(shs_cid) \
                    or {}  # optional: attach by_course to ctx if you like
            cand_list = list(cinfo.get("candidates", [])) or []

            # If you don't have by_course on ctx, fall back to all faculty:
            if not cand_list:
                cand_list = [{"faculty_id": f.get("faculty_id")} for f in ctx.faculty]

            backfill_fids = [
                c.get("faculty_id") for c in cand_list
                if c.get("faculty_id") and c.get("faculty_id") != donor_fid
            ]
            # PTs first
            backfill_fids = sorted(      
                backfill_fids,
                key=lambda fid: 0 if _is_pt(ctx, fid) else 1
            )

            # 🔍 DEBUG: see who we will even try as backfill
            _dbg(
                f"  potential backfills for SHS {shs_sid} ({shs_cid}) "
                f"donor={donor_fid}: {backfill_fids}"
            )

            bf: str | None = None
            for fid2 in backfill_fids:
                if fid2 in (getattr(ctx, "leave_blocked", set()) or set()):
                    _dbg(f"    skip backfill {fid2} (leave_blocked)")
                    continue

                _dbg(f"    try backfill {fid2} for SHS {shs_sid}")
                # Backfill must pass full feasibility (including capacity)
                if not _can_take(fid2, shs_sid):
                    _dbg(f"      backfill {fid2} CANNOT take SHS {shs_sid} (see RESCUE_CAN_TAKE above)")
                    continue

                _dbg(f"      backfill {fid2} OK for SHS {shs_sid}")
                bf = fid2
                break

            # compute current global remaining capacity once per donor
            no_capacity_left = (_total_remaining_capacity(ctx, assignments) == 0)
            _dbg(
                f"  after donor/backfill scan for donor {donor_fid} on SHS {shs_sid}: "
                f"bf={bf}, no_capacity_left={no_capacity_left}"
            )


            blank_ud = units.get(cid_blank, 3)
            shs_ud   = units.get(shs_cid, 3)
            donor_current = used.get(donor_fid, 0)
            donor_post = donor_current - shs_ud + blank_ud

            # If donor would exceed their cap after swapping, skip this donor entirely
            if donor_post > caps.get(donor_fid, 0):
                continue

            if bf is None:
                # --- SACRIFICE MODE: only allowed if everyone is maxed ---
                if not (POLICY_ALLOW_SHS_SACRIFICE_IF_NO_CAPACITY and no_capacity_left):
                    continue

                # Treat sacrifice as a worse rank than any safe backfill
                rank = (2, 0)
                if (best is None) or (rank < best["rank"]):
                    best = {
                        "rank": rank,
                        "donor_fid": donor_fid,
                        "donor_name": _display_name_from_users(ctx.users_by_faculty.get(donor_fid)),
                        "sid_shs": shs_sid,
                        "backfill_fid": None,
                        "backfill_name": "",
                        "donor_post": donor_post,
                    }
                continue  # check other donors

            # --- Normal case: we DO have a backfill ---
            pt_pref = 0 if _is_pt(ctx, bf) else 1
            conc_nudge = 0
            if _section_campus(ctx, shs_sid) == "CMPS0002" and _is_pt(ctx, bf) and _is_solo_campus2_pref(ctx, bf):
                conc_nudge = -1
            rank = (pt_pref, conc_nudge)

            if (best is None) or (rank < best["rank"]):
                best = {
                    "rank": rank,
                    "donor_fid": donor_fid,
                    "donor_name": _display_name_from_users(ctx.users_by_faculty.get(donor_fid)),
                    "sid_shs": shs_sid,
                    "backfill_fid": bf,
                    "backfill_name": _display_name_from_users(ctx.users_by_faculty.get(bf)),
                    "donor_post": donor_post,
                }

        if best:
            _dbg(
                f"==> RESCUED {sid_blank} using donor={best['donor_fid']} "
                f"from SHS={best['sid_shs']} backfill={best.get('backfill_fid')}"
            )
        else:
            _dbg(f"==> FAILED to rescue blank {sid_blank}: no feasible donor+backfill combo")

        
        # Apply chosen move (if any) for this blank
        if best:
            donor_fid   = best["donor_fid"]
            donor_name  = best["donor_name"]
            shs_sid     = best["sid_shs"]
            shs_cid     = section_to_course.get(shs_sid, "")
            shs_units   = units.get(shs_cid, 3)
            blank_units = units.get(cid_blank, 3)

            if best["backfill_fid"]:
                # normal atomic swap (donor -> blank, backfill -> SHS)
                bf = best["backfill_fid"]
                bf_name = best["backfill_name"]
                assignments = _swap(
                    assignments,
                    sid_blank, donor_fid, donor_name,
                    shs_sid, bf, bf_name,
                )
                # update usage tallies
                used[donor_fid] = used.get(donor_fid, 0) - shs_units + blank_units
                used[bf]        = used.get(bf, 0) + shs_units
            else:
                # --- SACRIFICE MODE: move donor to blank and leave SHS unassigned ---
                # 1) remove donor's SHS assignment
                assignments = [a for a in assignments if a.get("section_id") != shs_sid]
                # 2) assign donor to blank
                assignments = [a for a in assignments if a.get("section_id") != sid_blank] + [{
                    "section_id": sid_blank,
                    "course_id": cid_blank,
                    "faculty_id": donor_fid,
                    "faculty": donor_name,
                    "status": "Pending",
                }]
                # 3) adjust donor usage (−SHS + blank)
                used[donor_fid] = used.get(donor_fid, 0) - shs_units + blank_units

            # donor’s former SHS is no longer in donor pool
            shs_pool = [a for a in shs_pool if a.get("section_id") != shs_sid]

    _dbg("end of run_pass_rescue_non_shs")
    return assignments

# =============  MILESTONE E — Phase 7 (SHS soft-locks + Proposed Times)  =============
async def run_milestone_e_phase7(term_id: str, db, department_id: str | None = None) -> dict:
    """
    Builds on Phase 6B results.
    - Keep SHS sections' schedules as-is (soft-locked).
    - For sections with no schedule, propose day/time based on faculty prefs.
      (We do not persist; we only surface proposed times in the assignment payload.)
    """
    base = await run_milestone_d2_rebalance_shs_to_cover_nshs(term_id, db, department_id)
    assignments = list(base.get("assignments", []))

    # ---------------- PRE-CAP CONTEXT + DEBUG SHELL ----------------
    ctx = await phase0_load(term_id, db, department_id)
    dbg_prev = dict(base.get("debug", {}) or {})

    # --- HARD STOP: CAP PRUNE IMMEDIATELY AFTER D2 ---
    # This ensures:
    #   • D2 rebalances can overshoot caps a bit,
    #   • but we prune *once* here,
    #   • and all later passes (rescue / reclaim / concentrate) see the
    #     real blanks and respect caps.
    print("[CAP_ENFORCE] incoming_assignments:", len(assignments))
    assignments, used_units = _enforce_global_caps(ctx, assignments)
    print("[CAP_ENFORCE] assignments_after_prune:", len(assignments))
    print("[CAP_ENFORCE] used_units_after:", used_units)

    cap_dbg = dbg_prev.setdefault("cap_sanity", {})
    cap_dbg["assignments_after_prune"] = len(assignments)
    cap_dbg["used_units_by_faculty"] = {fid: int(u) for fid, u in used_units.items()}

    # ---------------- MICRO-PASSES ON TOP OF PRUNED SET -------------
    # 0) rescue pass: ensure no Major/Foundation/Other stays blank while SHS is filled
    assignments = run_pass_rescue_non_shs(ctx, assignments)

    # 1) optional: FT-first reclaim (keeps SHS+rules & caps)
    assignments = run_pass_ft_reclaim_from_pt(ctx, assignments)

    # 2) optional: improve CMPS0002 concentration (keeps rules; we keep loads balanced)
    assignments = run_pass_campus_concentrate_cmps2(ctx, assignments)

    # From here down, we only propose times and don’t change who teaches what.
    # Rebuild context for schedules / types (separate from capacity ctx above).
    courses_ctx = await phase0_load(term_id, db, department_id)
    courses = courses_ctx.courses
    schedules_by_section = courses_ctx.schedules_by_section or {}
    fac_prefs = courses_ctx.prefs_by_faculty or {}
    sections_by_id = {s["section_id"]: s for s in courses_ctx.sections}

    campus_blocked = getattr(courses_ctx, "campus_blocked", {}) or {}

    def _is_blocked_ge_cmps2_slot(sid: str, di: int, interval: tuple[int, int]) -> bool:
        """
        CMPS0002 GE sections should not be scheduled in a time window that exactly
        matches any existing CMPS0002 section (blocked windows).
        """
        sec = sections_by_id.get(sid, {})
        campus = (sec.get("campus_id") or "").strip().upper()
        cid = sec.get("course_id")
        c = (courses.get(cid) or {})
        ttype = str(c.get("type_of_course") or c.get("type") or "").strip().upper()

        if campus != "CMPS0002" or ttype != "GE":
            return False

        day_map = campus_blocked.get("CMPS0002", {})
        blocked_arr = day_map.get(di, [])
        return interval in blocked_arr


    def _course_is_shs(cid: str) -> bool:
        t = (courses.get(cid) or {}).get("type") or (courses.get(cid) or {}).get("type_of_course")
        return str(t).strip().upper() == "SHS"

    def _first_window(fp: dict) -> tuple[int,int] | None:
        """Pick the first usable preferred time window from prefs (strings, pairs, or dicts)."""
        times = (fp or {}).get("preferred_times")
        if not times:
            return None
        seq = times if isinstance(times, list) else [times]
        for t in seq:
            if isinstance(t, dict):
                st = _to_min(t.get("start") or t.get("begin"))
                en = _to_min(t.get("end")   or t.get("finish"))
            elif isinstance(t, (list, tuple)) and len(t) == 2:
                st, en = _to_min(t[0]), _to_min(t[1])
            elif isinstance(t, str):
                s = t.strip().upper().replace("\u2013", "-").replace("\u2014", "-")
                if "-" in s:
                    a, b = s.split("-", 1)
                    st, en = _to_min(a), _to_min(b)
                else:
                    # bucket keywords
                    buckets = {
                        "AM": (0, 12*60), "PM": (12*60, 24*60),
                        "MORNING": (6*60, 12*60), "AFTERNOON": (12*60, 18*60),
                        "EVENING": (17*60, 21*60), "NIGHT": (21*60, 24*60),
                    }
                    if s in buckets:
                        st, en = buckets[s]
                    else:
                        continue
            else:
                continue
            if st >= 0 and en > st:
                return (st, en)
        return None

    def _pick_days(fp: dict) -> tuple[str, str]:
        """Return paired days with directional order: day1 in {M,T,W} only; day2 = {H,F,S}."""
        pair = {"M":"H","T":"F","W":"S"}  # directional
        days = (fp or {}).get("availability_days") or []
        norm = []
        for d in days:
            s = str(d).strip().upper()
            if s == "TH": s = "H"
            if s in ("M","T","W","H","F","S"):
                norm.append(s)
        # pick first available anchor from M,T,W; else default M/H
        for anchor in ("M","T","W"):
            if anchor in norm:
                return (anchor, pair[anchor])
        return ("M", "H")

    # Build proposed times for sections that lack schedules ------------------
    proposed: list[dict] = []
    kept: list[dict] = []

     # NEW: collect reasons when a section ends with no proposed times (DEBUG)
    debug_no_time_phase7: dict[str, dict] = {}  # section_id -> reasons

    for a in assignments:
        sid = a["section_id"]; cid = a["course_id"]; fid = a["faculty_id"]
        has_sched = any(_slots_from_scheds(schedules_by_section.get(sid, [])))
        if has_sched:
            kept.append(a)
            # NEW: explain that we skipped because a schedule already exists (DEBUG)
            debug_no_time_phase7[sid] = {"reason": "has_existing_schedule"}
            continue

        if _course_is_shs(cid):
            kept.append(a)
            # NEW: SHS sections are soft-locked (DEBUG)
            debug_no_time_phase7[sid] = {"reason": "SHS_soft_lock"}
            continue

        fp = fac_prefs.get(fid, {})  # faculty preferences
        win = _first_window(fp)
        d1, d2 = _pick_days(fp)

        if not win and not d1:
            kept.append(a)
            # NEW: no usable window/days parsed from prefs
            debug_no_time_phase7[sid] = {
                "reason": "no_pref_window_or_days",
                "pref_snapshot": {
                    "availability_days": (fp or {}).get("availability_days"),
                    "preferred_times": (fp or {}).get("preferred_times"),
                },
            }
            continue

        st, en = win if win else (None, None)

        # For CMPS0002 GE: avoid proposing into blocked campus windows
        if st is not None and en is not None:
            di1 = _DAY_MAP.get(d1, _DAY_MAP.get(d1[:1], -1)) if d1 else -1
            di2 = _DAY_MAP.get(d2, _DAY_MAP.get(d2[:1], -1)) if d2 else -1
            sid = a["section_id"]
            interval = (st, en)

            if (di1 > 0 and _is_blocked_ge_cmps2_slot(sid, di1, interval)) or \
               (di2 > 0 and _is_blocked_ge_cmps2_slot(sid, di2, interval)):
                kept.append(a)
                debug_no_time_phase7[sid] = {
                    "reason": "blocked_ge_cmps2_slot",
                    "days": [d1, d2],
                    "window_min": interval,
                }
                continue

        assn = dict(a)
        # inject proposal into standard fields so UI shows times
        if d1:
            assn["day1"] = d1
            if st is not None: assn["begin1"] = _mm_to_hhmm(st)
            if en is not None: assn["end1"]   = _mm_to_hhmm(en)
        if d2:
            assn["day2"] = d2
            if st is not None: assn["begin2"] = _mm_to_hhmm(st)
            if en is not None: assn["end2"]   = _mm_to_hhmm(en)
        # leave room blank; status remains Pending
        # NEW: note that we did propose times
        debug_no_time_phase7.pop(sid, None)
        proposed.append(assn)

    final_assignments = kept + proposed

    debug7 = {
        "phase7_proposed_count": len(proposed),
        "phase7_kept_count": len(kept),
        "phase7_note": "Proposed times based on availability_days/preferred_times for unscheduled, non-SHS sections.",
        "phase7_no_time_details": debug_no_time_phase7,
    }

    return {
        **base,
        "assignments": final_assignments,
        "debug": {**dbg_prev, **debug7},
    }

# =============  END MILESTONE E — Phase 7  ==========================

async def _approve_and_persist(term_id: str, rows: list[dict], db):
    """
    For each approved row:
      - Upsert faculty_assignments(term_id, section_id) -> faculty_id, course_id, status='Confirmed'
      - Upsert section_schedules (non-SHS only) from day/begin/end pairs
    Idempotent: same keys will be overwritten, not duplicated.
    """
    # Load context once (course types, existing schedules, section→course map, etc.)
    ctx = await phase0_load(term_id, db, department_id=None)
    section_to_course = {s["section_id"]: s["course_id"] for s in ctx.sections}

    # quick course-type checker
    def _course_is_shs(cid: str) -> bool:
        t = (ctx.courses.get(cid) or {}).get("type") or (ctx.courses.get(cid) or {}).get("type_of_course")
        return str(t).strip().upper() == "SHS"

    # Build a dict from section_id -> (faculty_id, course_id) using the latest compute run
    sugg = await compute_load_recommendations(term_id=term_id, db=db)
    by_sid = {a["section_id"]: a for a in (sugg.get("assignments") or [])}

    # --- NEW: preflight used slots to prevent duplicates across the batch ---
    used: dict[str, set[tuple[str,str,str]]] = {}

    def _add_used(fid: str | None, d: str | None, b: str | None, e: str | None):
        if not fid or not d or not b or not e:
            return
        used.setdefault(fid, set()).add((str(d).upper(), str(b), str(e)))

    def _dup(fid: str | None, d: str | None, b: str | None, e: str | None) -> bool:
        if not fid or not d or not b or not e:
            return False
        return (str(d).upper(), str(b), str(e)) in used.get(fid, set())

    # Process each approved row
    for r in rows:
        sid = r.get("id") or r.get("section_id")
        if not sid:
            continue
        a = by_sid.get(sid) or {}

        # Prefer the faculty manually chosen in the row; fall back to the latest compute suggestion.
        fid = r.get("faculty_id") or a.get("faculty_id")
        cid = a.get("course_id") or section_to_course.get(sid)

        # --- Allow SHS fallback: use the row faculty_id even if missing in compute output ---
        if not fid and _course_is_shs(cid):
            fid = r.get("faculty_id")

        # skip rows without an assigned faculty or those marked Conflict/Unassigned
        status = (r.get("status") or "Pending").capitalize()

        # --- NEW: keep sections.mode in sync with the row's mode (if present) ---
        row_mode = str(r.get("mode") or "").strip().upper()
        if row_mode:
            await db[COL_SECTIONS].update_one(
                {"section_id": sid},
                {"$set": {"mode": row_mode}},
                upsert=False,
            )

        # Skip only if truly missing faculty (except SHS, which may show 'Unassigned')
        if not fid:
            continue

        # For non-SHS courses, skip if marked Conflict/Unassigned
        if status in ("Conflict", "Unassigned") and not _course_is_shs(cid):
            continue

        # ---------- 1) faculty_assignments upsert (preserve legacy; not archived) ----------
        # If there is already an assignment doc for this section (legacy or new schema),
        # update it in-place and KEEP its legacy fields (assignment_id, load_id).
        existing = await db[COL_ASSIGN].find_one(
            {"section_id": sid},
            {"_id": 0, "assignment_id": 1, "load_id": 1}
        )

        set_fields = {
            "section_id": sid,
            "faculty_id": fid,
            "created_at": _utcnow(),
            "is_archived": False,   
        }
        # preserve legacy identifiers if present
        if existing:
            if existing.get("assignment_id"): set_fields["assignment_id"] = existing["assignment_id"]
            if existing.get("load_id"):       set_fields["load_id"] = existing["load_id"]

        # Use section_id-only filter so we update a legacy row if it exists
        await db[COL_ASSIGN].update_one(
            {"section_id": sid},
            {"$set": set_fields},
            upsert=True,
        )

        # ---------- 2) section_schedules upsert (non-SHS only) ----------
        if not cid:
            continue
        if _course_is_shs(cid):
            # keep SHS schedule as-is (soft-locked)
            continue

        # pull proposed times from the row (already normalized in UI/run)
        pairs = [("day1","begin1","end1",1),("day2","begin2","end2",2)]
        for dkey, bkey, ekey, ordn in pairs:
            day = (r.get(dkey) or "").strip().upper()
            begin_hhmm = _norm_hhmm(r.get(bkey))
            end_hhmm   = _norm_hhmm(r.get(ekey))
            if not day or not begin_hhmm or not end_hhmm:
                continue

            # duplicate-slot check only if we actually know the faculty
            if fid and _dup(fid, day, begin_hhmm, end_hhmm):
                continue

            schedule_id = _sched_id(sid, ordn)

            # --- NEW: preserve existing room_id if already saved for this schedule ---
            existing_sched = await db[COL_SCHED].find_one(
                {"schedule_id": schedule_id},
                {"_id": 0, "room_id": 1}
            )
            existing_room_id = (existing_sched or {}).get("room_id") or ""

            # Only accept a REAL room id from the row; ignore placeholders like "Online"/"Classroom"/"TBA"
            row_room_val = (r.get(f"room{ordn}") or "").strip()
            final_room_id = existing_room_id
            if not final_room_id and _looks_like_room_id(row_room_val):
                final_room_id = row_room_val

            # --- NEW: derive room_type from final_room_id (do not guess otherwise) ---
            if final_room_id:
                # map room_id → rooms.room_type
                room_doc = await db[COL_ROOMS].find_one(
                    {"room_id": final_room_id},
                    {"_id": 0, "room_type": 1}
                )
                final_room_type = (room_doc or {}).get("room_type") or ""
            else:
                # no room selected → treat as fully online for this slot
                final_room_type = "Online"

            await db[COL_SCHED].update_one(
                {"schedule_id": schedule_id},
                {
                    "$set": {
                        "schedule_id": schedule_id,
                        "term_id": term_id,
                        "section_id": sid,
                        "day": day,
                        "start_time": _to_compact_hhmm(begin_hhmm),
                        "end_time": _to_compact_hhmm(end_hhmm),
                        # keep existing room_id if it exists; otherwise set what the row proposes
                        "room_id": final_room_id,
                        # always align room_type to the final room choice (or Online when no room)
                        "room_type": final_room_type,
                        "created_at": r.get("created_at") or "",
                        "updated_at": r.get("updated_at") or "",
                    }
                },
                upsert=True,
            )

            _add_used(fid, day, begin_hhmm, end_hhmm)

async def _upsert_faculty_load_header(
    term: dict,
    db,
    *,
    department_id: str,
    user_id: str,
) -> None:
    """
    Ensure a faculty_loads header exists for this term+department
    with status='approved' and total_units computed from the term's sections.
    If it already exists, update status/total_units/timestamps.
    """
    if not term:
        return

    term_id = term.get("term_id")
    if not term_id:
        return

    # Use phase0 context to compute total units for all sections in this term.
    ctx = await phase0_load(term_id, db, department_id=None)
    total_units = 0
    for s in ctx.sections or []:
        # section.units, else course.units
        cid = s.get("course_id")
        units = s.get("units") or (ctx.courses.get(cid, {}) or {}).get("units")
        try:
            total_units += int(units or 0)
        except Exception:
            continue

    now = _utcnow()

    # Check if we already have a header for this term+department
    existing = await db[COL_FACULTY_LOADS].find_one(
        {"term_id": term_id, "department_id": department_id}
    )

    if not existing:
        # create new
        new_load_id = await _next_load_id(db)
        doc = {
            "load_id": new_load_id,
            "term_id": term_id,
            "department_id": department_id,
            "status": "approved",
            "total_units": total_units,
            "created_by": user_id,
            "created_at": now,
            "finalized_at": now,
            "updated_at": now,
        }
        await db[COL_FACULTY_LOADS].insert_one(doc)
    else:
        # update existing header
        await db[COL_FACULTY_LOADS].update_one(
            {"_id": existing["_id"]},
            {
                "$set": {
                    "status": "approved",
                    "total_units": total_units,
                    "updated_at": now,
                    "finalized_at": now,
                    # keep old created_by/created_at if already set
                    "created_by": existing.get("created_by") or user_id,
                }
            },
        )

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
        dbg_after_leave = 0
        dbg_kac_ok = 0
        dbg_campus_mode_ok = 0
        dbg_time_ok = 0

        for f in ctx.faculty:
            fid = f["faculty_id"]
            dbg_total += 1
            cap = int(caps.get(fid, 0))
            if cap <= 0:
                continue
             # GS rule: only PhD faculty can teach GS-program courses
            if _course_requires_phd(ctx, cid) and not _has_phd_cert(ctx, fid):
                continue        

            # (0) Require a submitted preference for the upcoming term
            # if fid not in ctx.prefs_by_faculty:
            #     continue
            has_prefs = fid in ctx.prefs_by_faculty

            # (0b) Exclude if on approved leave overlapping this term
            if fid in (getattr(ctx, "leave_blocked", set()) or set()):
                continue
            dbg_after_leave += 1   # NEW: survived leave gate

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

            # # (C) Campus / mode gates — drive strictly from THIS TERM’S preferences
            # fpref = (ctx.prefs_by_faculty.get(fid) or {})
            # if not _campus_compat_pref(fpref, campus):
            #     continue
            # if not _mode_compat_pref(fpref, mode):
            #     continue

            dbg_campus_mode_ok += 1
            dbg_time_ok += 1

            # (E) Course-aware scoring
            hx = int(getattr(ctx, "history_map", {}).get((fid, cid), 0))
            prefers_this_kac = 1 if (course_kacs and pref_kacs and course_kacs.intersection(pref_kacs)) else 0
            qual_matches_union = 1 if (course_kacs and course_kacs.intersection(fac_kacs_union)) else 0

            emp = (f.get("employment_type") or "").strip().upper()  # "FT" / "PT"
            ft_bonus = 1 if emp == "FT" else 0

            score = (40*prefers_this_kac) + (25*hx) + (10*ft_bonus) + (5*qual_matches_union) + min(cap, 12)
            if not has_prefs:
                score -= 20  # soft penalty, still eligible

            # --- NEW TAGS: solo-campus based on preferences of THIS TERM ---
            fpref = (ctx.prefs_by_faculty.get(fid) or {})
            campus_list = ((fpref.get("mode") or {}).get("campus_id") or [])
            campus_set = {str(x).strip().upper() for x in campus_list if x}
            is_solo_campus2 = (campus_set == {"CMPS0002"})
            is_ft_solo_campus2 = (emp == "FT" and is_solo_campus2)

            name = _display_name_from_users(ctx.users_by_faculty.get(fid))

            cands.append({
                "faculty_id": fid,
                "name": name,
                "remaining_units": cap,
                "employment_type": f.get("employment_type", ""),
                "score": score,
                # NEW: carry tags for downstream promotion
                "tags": {
                    "soloCampus2": bool(is_solo_campus2),
                    "FT_soloCampus2": bool(is_ft_solo_campus2),
                    # keep existing tags you already compute elsewhere (e.g., coordinator, soloKAC)
                },
            })

        # sort: higher score first, then more capacity, then FT, then name
        def _promote_flags(c):
            tags = c.get("tags", {}) or {}
            # True → 0, False → 1 so that promoted items come first
            is_coord = 0 if tags.get("coordinator") else 1
            is_ft_solo2 = 0 if tags.get("FT_soloCampus2") else 1
            is_solo2 = 0 if tags.get("soloCampus2") else 1
            is_solo_kac = 0 if tags.get("soloKAC") else 1
            return (is_coord, is_ft_solo2, is_solo2, is_solo_kac)

        cands.sort(key=lambda x: (
            *_promote_flags(x),
            -x["score"],
            -x["remaining_units"],
            0 if (x.get("employment_type","").strip().upper() == "FT") else 1,
            x["name"],
        ))

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

        _apply_solo_kac_tags(ctx, by_course, cid, cands, course_kacs)
        _apply_protection_tags(by_course, cid, coord_ids, topk_ids)
        # --------------------------- END PHASE 5 -----------------------------

        by_course[cid]["_debug_filters"] = {
            "pool": dbg_total,
            "after_leave": dbg_after_leave,
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
        "pref_windows_quality": getattr(ctx, "pref_windows_quality", {}),
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
    MILESTONE = "E"
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
    if MILESTONE == "D":
        return await run_milestone_d_phase6b(term_id, db, department_id)
    if MILESTONE == "E":
        return await run_milestone_e_phase7(term_id, db, department_id)

    return {"term_id": term_id, "courses_order": [], "by_course": {}, "assignments": []}