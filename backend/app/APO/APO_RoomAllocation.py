# app/routes/apo.py
from datetime import datetime
import re
from typing import Any, Dict, List, Optional, Tuple, Literal, Set
from fastapi import APIRouter, HTTPException, Query, Body
from ..main import db
from ..Notifications import create_notification

router = APIRouter(prefix="/apo", tags=["apo"])

# ---- collections ----
COL_ROOMS = "rooms"
COL_CAMPUSES = "campuses"
COL_TERMS = "terms"
COL_SECTIONS = "sections"
COL_SCHEDS = "section_schedules"
COL_COURSES = "courses"
COL_USER_ROLES = "user_roles"           # role catalog (ROLE0004 => APO)
COL_ROLE_ASSIGN = "role_assignments"    # per-user assignments + scopes
COL_DEPARTMENTS = "departments"
COL_FAC_ASSIGN = "faculty_assignments"
COL_FAC_LOADS = "faculty_loads"
COL_FAC_PROFILES = "faculty_profiles"
COL_USERS = "users"

# Frontend expects full names; DB may use codes
DOW = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

DAY_CODE_TO_NAME = {
    # Monday
    "M": "Monday", "MON": "Monday", "MONDAY": "Monday",
    # Tuesday
    "T": "Tuesday", "TU": "Tuesday", "TUE": "Tuesday", "TUESDAY": "Tuesday",
    # Wednesday
    "W": "Wednesday", "WED": "Wednesday", "WEDNESDAY": "Wednesday",
    # Thursday (include H/R)
    "H": "Thursday", "THU": "Thursday", "THUR": "Thursday", "THURS": "Thursday", "THURSDAY": "Thursday",
    "H": "Thursday", "R": "Thursday",
    # Friday
    "F": "Friday", "FRI": "Friday", "FRIDAY": "Friday",
    # Saturday
    "S": "Saturday", "SAT": "Saturday", "SATURDAY": "Saturday",
}

DAY_NAME_TO_CODE = {
    "Monday": "M", "Tuesday": "T", "Wednesday": "W", "Thursday": "H", "Friday": "F", "Saturday": "S"
}

DAY_ALIASES: Dict[str, List[str]] = {
    "Monday": ["Monday", "M", "MON", "MONDAY"],
    "Tuesday": ["Tuesday", "T", "TU", "TUE", "TUESDAY"],
    "Wednesday": ["Wednesday", "W", "WED", "WEDNESDAY"],
    "Thursday": ["Thursday", "TH", "H", "R", "THU", "THUR", "THURS", "THURSDAY"],
    "Friday": ["Friday", "F", "FRI", "FRIDAY"],
    "Saturday": ["Saturday", "S", "SAT", "SATURDAY"],
}

TIME_BANDS = [
    "07:30 – 09:00",
    "09:15 – 10:45",
    "11:00 – 12:30",
    "12:45 – 14:15",
    "14:30 – 16:00",
    "16:15 – 17:45",
    "18:00 – 19:30",
]

ALLOWED_ROOM_TYPES = {"Classroom", "ComLab"}

# --- campus-based default open days when there are no in-scope section schedules ---
DEFAULT_OPEN_DAYS_MANILA = ["Thursday", "Friday", "Saturday"]
DEFAULT_OPEN_DAYS_LAGUNA = ["Monday", "Tuesday", "Wednesday", "Saturday"]

def default_open_days_for_campus(campus_name: str) -> List[str]:
    n = (campus_name or "").lower()
    # Laguna variants
    if "laguna" in n or "canlubang" in n or "biñan" in n or "binan" in n:
        return DEFAULT_OPEN_DAYS_LAGUNA
    # Default to Manila if not Laguna
    return DEFAULT_OPEN_DAYS_MANILA

def now() -> datetime:
    return datetime.utcnow()

def _t4(t: Any) -> str:
    """
    Normalize a time value into 'HHMM' (4 digits).
    Accepts:
      - '0730'
      - '07:30'
      - '07:30:00'
      - 730
      - '073000'
    Returns '' if malformed.
    """
    digits = "".join(ch for ch in str(t) if ch.isdigit())
    if not digits:
        return ""
    if len(digits) >= 4:
        digits = digits[:4]
    elif len(digits) == 3:
        digits = "0" + digits
    else:
        return ""

    try:
        hh = int(digits[:2])
        mm = int(digits[2:])
        if not (0 <= hh <= 23 and 0 <= mm <= 59):
            return ""
    except Exception:
        return ""

    return f"{hh:02d}{mm:02d}"

def fmt_pair(t) -> str:
    """Format a time value into 'HH:MM'. Returns '' if malformed."""
    s = _t4(t)
    return f"{s[:2]}:{s[2:]}" if s else ""

def band_of(start, end) -> str:
    """Return 'HH:MM – HH:MM' or '' if invalid."""
    a, b = fmt_pair(start), fmt_pair(end)
    return f"{a} – {b}" if (a and b) else ""

_BAND_SPLIT_RE = re.compile(r"\s*[-–—]\s*")

def parse_band(band: str) -> Tuple[str, str]:
    """
    Parse a time-band string and return ('HHMM','HHMM').
    Accepts:
      - 'HH:MM – HH:MM'
      - 'HH:MM - HH:MM'
      - 'HHMM-HHMM'
      - 'HHMMHHMM'
    """
    raw = (band or "").strip()
    if not raw:
        raise HTTPException(
            status_code=400,
            detail="Invalid time band (use HH:MM – HH:MM, HH:MM - HH:MM, HHMM-HHMM, or HHMMHHMM).",
        )

    parts = _BAND_SPLIT_RE.split(raw)
    st = et = ""

    if len(parts) >= 2:
        st = _t4(parts[0])
        et = _t4(parts[1])
    else:
        digits = "".join(ch for ch in raw if ch.isdigit())
        if len(digits) == 8:
            st = _t4(digits[:4])
            et = _t4(digits[4:])

    if not (st and et):
        raise HTTPException(
            status_code=400,
            detail="Invalid time band (use HH:MM – HH:MM, HH:MM - HH:MM, HHMM-HHMM, or HHMMHHMM).",
        )

    return (st, et)

def normalize_day(d: Any) -> str:
    if not d:
        return ""
    s = str(d).strip()
    if s in DOW:
        return s
    u = s.upper()
    if u in DAY_CODE_TO_NAME:
        return DAY_CODE_TO_NAME[u]
    t = s.title()
    return t if t in DOW else s

def denormalize_day(d: str) -> str:
    return DAY_NAME_TO_CODE.get(d, d)

def day_aliases(day_full: str) -> List[str]:
    return DAY_ALIASES.get(day_full, [day_full])



def _first_str(v: Any) -> str:
    """Return first string if `v` is a list; else return `v` if it's a string; else ''.

    Mongo fields like `room_type` sometimes come back as a list (e.g., ['Classroom']).
    Normalizing here avoids mismatches between eligibility filtering and assign validation.
    """
    if isinstance(v, list):
        for item in v:
            if isinstance(item, str):
                return item
        return ""
    return v if isinstance(v, str) else ""

def normalize_room_type(rt: str) -> str:
    """Normalize physical room types.

    Returns '' for non-physical delivery modes (e.g., 'Online'), so callers can treat
    it as "no constraint".
    """
    u = (rt or "").strip().lower().replace(" ", "")
    if u in {"classroom", "class", "cr"}:
        return "Classroom"
    if u in {"comlab", "lab", "computerlab", "laboratory"}:
        return "ComLab"
    # delivery modes / not-a-room requirements
    if u in {"online", "onl", "virtual", "remote", "async", "asynch", "asynchronous",
             "sync", "synchronous", "hybrid", "blended", "tba", "na", "n/a", "none"}:
        return ""
    return (rt or "").strip()

def campus_section_prefix(campus_name: str) -> Optional[tuple[str, ...] | str]:
    n = (campus_name or "").lower()
    if "laguna" in n or "canlubang" in n or "binan" in n or "biñan" in n:
        # Accept both XX… and XC… section codes for Laguna
        return ("XX", "XC")
    if "manila" in n or "taft" in n:
        return "S"
    return None

async def resolve_term_id_with_sections_fallback() -> Optional[str]:
    """Prefer current term; else the most recent term that actually has sections."""
    t = await db[COL_TERMS].find_one({"is_current": True}, {"_id": 0, "term_id": 1})
    if t:
        tid = t["term_id"]
        if await db[COL_SECTIONS].count_documents({"term_id": tid}) > 0:
            return tid
    # fall back to most recently touched sections' term
    sec = await db[COL_SECTIONS].find(
        {}, {"_id": 0, "term_id": 1, "updated_at": 1, "created_at": 1}
    ).sort([("updated_at", -1), ("created_at", -1)]).limit(1).to_list(length=1)
    if sec:
        return sec[0].get("term_id")
    # last resort: latest term by metadata
    cur = db[COL_TERMS].find({}, {"_id": 0, "term_id": 1, "start_at": 1, "term_number": 1}).sort(
        [("start_at", -1), ("term_number", -1)]
    ).limit(1)
    rows = [x async for x in cur]
    return rows[0]["term_id"] if rows else None

async def apo_scope(user_id: str) -> Tuple[Optional[str], Optional[str]]:
    role = await db[COL_USER_ROLES].find_one(
        {"role_type": {"$regex": "^APO$", "$options": "i"}},
        {"_id": 0, "role_id": 1},
    )
    if not role:
        return (None, None)
    ra = await db[COL_ROLE_ASSIGN].find_one(
        {"user_id": user_id, "role_id": role["role_id"]},
        {"_id": 0, "scope": 1},
    )
    if not ra or not ra.get("scope"):
        return (None, None)
    campus_id = None
    college_id = None
    for s in ra["scope"]:
        if s.get("type") == "campus":
            campus_id = s.get("id")
        if s.get("type") == "college":
            college_id = s.get("id")
    return (campus_id, college_id)

async def campus_meta(campus_id: Optional[str]) -> Dict[str, str]:
    if not campus_id:
        return {"campus_id": "", "campus_name": ""}
    c = await db[COL_CAMPUSES].find_one(
        {"campus_id": campus_id}, {"_id": 0, "campus_id": 1, "campus_name": 1}
    )
    return c or {"campus_id": campus_id, "campus_name": ""}

async def sections_map(term_id: str) -> Dict[str, Dict[str, Any]]:
    """
    section_id -> { section_id, section_code, course_id, course_code, college_id }
    course_code enriched from courses (first element if an array)
    """
    out: Dict[str, Dict[str, Any]] = {}
    cursor = db[COL_SECTIONS].find(
        {"term_id": term_id},
        {"_id": 0, "section_id": 1, "section_code": 1, "course_id": 1, "enrollment_cap": 1},
    )
    secs = [s async for s in cursor]
    cids = [s["course_id"] for s in secs if s.get("course_id")]
    code_map: Dict[str, str] = {}
    college_map: Dict[str, str] = {}
    if cids:
        cc = db[COL_COURSES].find(
            {"course_id": {"$in": list(set(cids))}},
            {"_id": 0, "course_id": 1, "course_code": 1, "college_id": 1},
        )
        for c in [x async for x in cc]:
            v = c.get("course_code")
            code_map[c["course_id"]] = v[0] if isinstance(v, list) and v else (v if isinstance(v, str) else "")
            if c.get("college_id"):
                college_map[c["course_id"]] = c["college_id"]
    for s in secs:
        cid = s.get("course_id", "")
        out[s["section_id"]] = {
            "section_id": s["section_id"],
            "section_code": s.get("section_code", ""),
            "course_id": cid,
            "course_code": code_map.get(cid, ""),
            "college_id": college_map.get(cid, ""),
            "enrollment_cap": s.get("enrollment_cap"),
        }
    return out

async def faculty_by_section_first(sec_ids: List[str], term_id: str) -> Dict[str, Dict[str, str]]:
    """
    Resolve one faculty per section (first hit).
    Priority:
      1) faculty_assignments joined to faculty_loads(term_id), not archived
      2) Fallback to section_schedules.faculty_id (any row for the section)
    Names are fetched via faculty_profiles -> users and formatted as 'LAST, FIRST'.
    """
    if not sec_ids:
        return {}

    # -------- Primary: assignments tied to loads in the active term --------
    load_ids = [x["load_id"] async for x in db[COL_FAC_LOADS].find(
        {"term_id": term_id}, {"_id": 0, "load_id": 1}
    )]

    fa_cond: Dict[str, Any] = {
        "section_id": {"$in": sec_ids},
        "is_archived": {"$ne": True},
    }
    # Only enforce load_id filter if we actually found loads for the term.
    # IMPORTANT: some planning rows in faculty_assignments may not yet have a load_id (or have it blank),
    # so we must not accidentally drop valid faculty_id links.
    if load_ids:
        fa_cond["$or"] = [
            {"load_id": {"$in": load_ids}},
            {"load_id": {"$exists": False}},
            {"load_id": None},
            {"load_id": ""},
        ]

    fa_rows = [x async for x in db[COL_FAC_ASSIGN].find(
        fa_cond, {"_id": 0, "section_id": 1, "faculty_id": 1}
    )]

    # -------- Fallback: pull faculty_id directly from section_schedules --------
    have_sid = {r.get("section_id") for r in fa_rows if r.get("section_id")}
    missing_secs = [sid for sid in sec_ids if sid not in have_sid]

    if missing_secs:
        ss_rows = [x async for x in db[COL_SCHEDS].find(
            {
                "section_id": {"$in": missing_secs},
                "faculty_id": {"$exists": True, "$ne": ""},
            },
            {"_id": 0, "section_id": 1, "faculty_id": 1}
        )]
        # prefer first found faculty per section
        seen = set()
        for r in ss_rows:
            sid = r.get("section_id")
            if sid and sid not in have_sid and sid not in seen:
                fa_rows.append({"section_id": sid, "faculty_id": r.get("faculty_id", "")})
                seen.add(sid)

    # If still nothing, return early
    fac_ids = list({r.get("faculty_id") for r in fa_rows if r.get("faculty_id")})
    if not fac_ids:
        return {}

    # -------- Map faculty_id -> user_id --------
    profs = [x async for x in db[COL_FAC_PROFILES].find(
        {"faculty_id": {"$in": fac_ids}},
        {"_id": 0, "faculty_id": 1, "user_id": 1}
    )]
    uid_by_fid = {p["faculty_id"]: p.get("user_id", "") for p in profs}

    # -------- Map user_id -> "LAST, FIRST" --------
    uids = [u for u in uid_by_fid.values() if u]
    users = [x async for x in db[COL_USERS].find(
        {"user_id": {"$in": uids}},
        {"_id": 0, "user_id": 1, "first_name": 1, "last_name": 1}
    )]
    def fmt(u: Dict[str, Any]) -> str:
        ln = (u.get("last_name") or "").upper()
        fn = (u.get("first_name") or "").upper()
        return f"{ln}, {fn}".strip(", ").strip()

    name_by_uid = {u["user_id"]: fmt(u) for u in users}

    # -------- Build per-section map (keep first) --------
    out: Dict[str, Dict[str, str]] = {}
    for r in fa_rows:
        sid, fid = r.get("section_id"), r.get("faculty_id")
        if not sid or sid in out:
            continue
        uid = uid_by_fid.get(fid, "")
        out[sid] = {
            "faculty_id": fid or "",
            "user_id": uid or "",
            "faculty_name": name_by_uid.get(uid, ""),  # may be "" if user missing
        }
    return out

@router.get("/roomallocation")
async def get_room_allocation(
    userId: str = Query(..., min_length=3),
    termId: Optional[str] = Query(None),
):
    # Prefer the explicit term coming from Pre-Enlistment (via the frontend).
    # This keeps Room Allocation in sync with the term the APO is currently working on.
    effective_term_id: Optional[str] = None
    if termId:
        t = await db[COL_TERMS].find_one(
            {"term_id": termId},
            {"_id": 0, "term_id": 1},
        )
        if t:
            # Always honor a valid termId from the client
            effective_term_id = termId

    term_id = effective_term_id or await resolve_term_id_with_sections_fallback()

    if not term_id:
        return {
            "campus": {"campus_id": "", "campus_name": ""},
            "term_id": "",
            "term_number": None,
            "acad_year_start": None,
            "buildings": [],
            "timeBands": TIME_BANDS,
            "rooms": [],
            "sections": [],
            "sectionSchedules": [],
            "facultyBySection": {},
            "courses": [],
        }

    # Fetch term meta so FE can render "Term X · AY YYYY-YYYY"
    term_doc = await db[COL_TERMS].find_one(
        {"term_id": term_id},
        {"_id": 0, "term_number": 1, "acad_year_start": 1},
    )
    term_number = term_doc.get("term_number") if term_doc else None
    acad_year_start = term_doc.get("acad_year_start") if term_doc else None

    campus_id, college_id = await apo_scope(userId)

    if not campus_id:
        raise HTTPException(status_code=400, detail="Unable to resolve APO campus from role_assignments.")

    campus = await campus_meta(campus_id)
    sec_prefix = campus_section_prefix(campus.get("campus_name", ""))

    # campus rooms
    rooms_cur = db[COL_ROOMS].find(
        {"campus_id": campus_id},
        {"_id": 0, "room_id": 1, "room_number": 1, "room_type": 1, "capacity": 1, "building": 1, "campus_id": 1, "status": 1},
    )
    rooms = [r async for r in rooms_cur]
    room_ids = {r["room_id"] for r in rooms}

    # sections in term, then filter by college + campus prefix
    s_map_all = await sections_map(term_id)
    def section_in_scope(s: Dict[str, Any]) -> bool:
        ok = True
        if college_id and s.get("college_id"):
            ok = ok and (s["college_id"] == college_id)
        if sec_prefix and s.get("section_code"):
            ok = ok and s["section_code"].upper().startswith(sec_prefix)
        return ok
    s_map = {sid: s for sid, s in s_map_all.items() if section_in_scope(s)}
    sec_ids = list(s_map.keys())

    # courses (for FE labels)
    course_ids = sorted({v.get("course_id", "") for v in s_map.values() if v.get("course_id")})
    courses = []
    course_room_type: Dict[str, str] = {}   # ← ensure it exists even if no courses
    if course_ids:
        cc = db[COL_COURSES].find(
            {"course_id": {"$in": course_ids}},
            {"_id": 0, "course_id": 1, "course_code": 1, "college_id": 1, "room_type": 1},
        )
        courses = [x async for x in cc]
        course_room_type = {c["course_id"]: _first_str(c.get("room_type")) for c in courses}

    # ---- schedules ----
    # 1) Schedules for in-scope sections (these drive the Allocate modal)
    fields = {
        "_id": 0,
        "schedule_id": 1,
        "section_id": 1,
        "day": 1,
        "start_time": 1,
        "end_time": 1,
        "room_id": 1,
        "room_type": 1,  # optional: needed when schedules carry their own room_type
    }
    sched_cur_scoped = db[COL_SCHEDS].find({"section_id": {"$in": sec_ids}}, fields)
    scoped_raw = [s async for s in sched_cur_scoped]
    section_scheds_scoped = [
        {
            "schedule_id": s.get("schedule_id", ""),
            "section_id": s.get("section_id", ""),
            "day": normalize_day(s.get("day")),
            "start_time": s.get("start_time", ""),
            "end_time": s.get("end_time", ""),
            "room_id": s.get("room_id"),
            "room_type": normalize_room_type(_first_str(s.get("room_type")) or "") if s.get("room_type") else "",
            "time_band": band_of(s.get("start_time", ""), s.get("end_time", "")),
        }
        for s in scoped_raw
    ]

    # 2) Additionally pull ANY assigned row that targets a room in this campus,
    #    even if its section is out-of-scope (so the grid shows Occupied).
    assigned_cur = db[COL_SCHEDS].find(
        {"room_id": {"$in": list(room_ids)}, "section_id": {"$exists": True}},
        fields,
    )
    assigned_raw = [a async for a in assigned_cur]
    assigned_norm = [
        {
            "schedule_id": a.get("schedule_id", ""),
            "section_id": a.get("section_id", ""),
            "day": normalize_day(a.get("day")),
            "start_time": a.get("start_time", ""),
            "end_time": a.get("end_time", ""),
            "room_id": a.get("room_id"),
            "time_band": band_of(a.get("start_time", ""), a.get("end_time", "")),
        }
        for a in assigned_raw
    ]

    # sections for the *current planning term* (all campuses/colleges)
    in_term_sec_ids: Set[str] = set(s_map_all.keys())

    # keep only those whose section belongs to this term but is NOT in APO scope
    assigned_out_of_scope = [
        x
        for x in assigned_norm
        if x.get("section_id") not in s_map
        and x.get("section_id") in in_term_sec_ids
    ]

    # union for building the room grid
    section_scheds_for_grid = section_scheds_scoped + assigned_out_of_scope

    # room-specific availability placeholders (rows without section_id)
    avail_cur = db[COL_SCHEDS].find(
        {"room_id": {"$in": list(room_ids)}, "section_id": {"$exists": False}},
        {"_id": 0, "schedule_id": 1, "day": 1, "start_time": 1, "end_time": 1, "room_id": 1},
    )
    availability_raw = [a async for a in avail_cur]
    availability = [
        {
            "schedule_id": a.get("schedule_id"),
            "room_id": a.get("room_id"),
            "day": normalize_day(a.get("day")),
            "time_band": band_of(a.get("start_time", ""), a.get("end_time", "")),
        }
        for a in availability_raw
    ]

    # faculty map for scoped sections only
    fac_map_first = await faculty_by_section_first(sec_ids, term_id)

    # initialize full grid per room
    schedule_by_room: Dict[str, Dict[tuple, Dict[str, Any]]] = {}
    for r in rooms:
        rid = r["room_id"]
        schedule_by_room[rid] = {(d, tb): {"day": d, "time_band": tb, "section_id": None}
                                 for d in DOW for tb in TIME_BANDS}

    # mark assigned (both scoped + out-of-scope)
    for s in section_scheds_for_grid:
        rid = s.get("room_id")
        tb = (s.get("time_band") or "").strip()
        if not rid or rid not in schedule_by_room:
            continue
        if tb not in TIME_BANDS:
            continue
        key = (s["day"], tb)
        schedule_by_room[rid][key] = {"day": key[0], "time_band": key[1], "section_id": s.get("section_id")}


    # campus default open days
    default_open_days = default_open_days_for_campus(campus.get("campus_name", ""))

    def allowed_cells_for_room(rid: str) -> List[Dict[str, Any]]:
        # 1) Always include already-assigned cells (scoped + out-of-scope)
        assigned_keys = {
            (s["day"], s["time_band"])
            for s in section_scheds_for_grid
            if s.get("room_id") == rid
        }

        # 2) Saved availability placeholders (normalized days)
        avail_for_room = [a for a in availability if a["room_id"] == rid]
        saved_avail_keys = {(a["day"], a["time_band"]) for a in avail_for_room}
        saved_days = {a["day"] for a in avail_for_room}

        allowed_keys = set(assigned_keys) | saved_avail_keys

        # 3) Day-scoped default overlay:
        for d in default_open_days:
            if d not in saved_days:
                for tb in TIME_BANDS:
                    allowed_keys.add((d, tb))

        # Build a fast view over in-scope section schedules (not yet room-assigned)
        scheds_open = [
            s for s in section_scheds_scoped
            if not (s.get("room_id") or "").strip()
        ]
        # Quick lookups
        sec_meta = s_map            # from sections_map(); includes enrollment_cap

        def _cap(sid: str) -> int:
            try:
                v = sec_meta.get(sid, {}).get("enrollment_cap")
                return int(v) if v not in (None, "") else 0
            except Exception:
                return 0

        def _fallback_course_room_type(sid: str) -> str:
            """Fallback required room_type from the section's course metadata."""
            cid = sec_meta.get(sid, {}).get("course_id", "")
            return normalize_room_type(_first_str(course_room_type.get(cid, "")) or "")

        out = []
        for k, cell in schedule_by_room[rid].items():
            if k not in allowed_keys:
                continue
            day, band = k

            # Compute eligible sections for this room cell
            eligible: List[str] = []
            # Room properties
            this_room = next((rr for rr in rooms if rr["room_id"] == rid), None)
            r_cap = int(this_room.get("capacity") or 0) if this_room else 0
            r_type = normalize_room_type(_first_str(this_room.get("room_type")) or "") if this_room else ""

            for s in scheds_open:
                if normalize_day(s.get("day")) != day:
                    continue
                if band_of(s.get("start_time", ""), s.get("end_time", "")) != band:
                    continue
                sid = s.get("section_id", "")
                if not sid:
                    continue
                # capacity & type fit
                if r_cap and _cap(sid) and r_cap < _cap(sid):
                    continue
                # IMPORTANT: room_type is per-slot; prefer this schedule row's room_type
                need_type = normalize_room_type(_first_str(s.get("room_type")) or "") or _fallback_course_room_type(sid)
                if need_type and r_type and (need_type != r_type):
                    continue
                eligible.append(sid)


            c = dict(cell)
            c["allowed"] = True
            c["eligible_section_ids"] = eligible
            out.append(c)
        return out


    buildings = sorted(list({r.get("building", "") for r in rooms if r.get("building")}))

    rooms_out = []
    for r in rooms:
        rid = r["room_id"]
        rooms_out.append({
            "room_id": rid,
            "room_number": r["room_number"],
            "room_type": normalize_room_type(_first_str(r.get("room_type")) or ""),
            "capacity": r.get("capacity", 0),
            "building": r.get("building", ""),
            "campus_id": r.get("campus_id", ""),
            "status": r.get("status", ""),
            "schedule": allowed_cells_for_room(rid),
        })

    sections_list = list(s_map.values())

    return {
        "campus": campus,
        "term_id": term_id,
        "term_number": term_number,
        "acad_year_start": acad_year_start,
        "buildings": buildings,
        "timeBands": TIME_BANDS,
        "rooms": rooms_out,
        "sections": sections_list,
        # IMPORTANT: keep this scoped for the Allocate modal
        "sectionSchedules": section_scheds_scoped,
        "facultyBySection": fac_map_first,
        "courses": courses,
    }

@router.post("/roomallocation")
async def post_room_allocation(
    userId: str = Query(..., min_length=3),
    action: Literal["addRoom", "updateRoom", "setAvailability", "assign", "unassign", "removeRoom"] = Query(...),
    payload: Dict[str, Any] = Body(...),
):
    # Prefer explicit planning term from the frontend (same term as GET /roomallocation)
    payload_term_id = (payload.get("term_id") or "").strip()
    term_id = payload_term_id or await resolve_term_id_with_sections_fallback()
    if not term_id:
        raise HTTPException(status_code=400, detail="No active term.")

    campus_id, college_id = await apo_scope(userId)
    if not campus_id:
        raise HTTPException(status_code=400, detail="Unable to resolve APO campus from role_assignments.")

    campus = await campus_meta(campus_id)
    sec_prefix = campus_section_prefix(campus.get("campus_name", ""))

    if action == "addRoom":
        building = (payload.get("building") or "").strip()
        room_number = (payload.get("room_number") or "").strip()
        room_type_in = (payload.get("room_type") or "").strip()
        room_type = normalize_room_type(room_type_in)
        capacity = int(payload.get("capacity", 0) or 0)
        if not (building and room_number and room_type and capacity > 0):
            raise HTTPException(status_code=400, detail="Missing or invalid room fields.")
        if room_type not in ALLOWED_ROOM_TYPES:
            raise HTTPException(status_code=400, detail="room_type must be 'Classroom' or 'ComLab'.")
        rid = f"ROOM{int(datetime.utcnow().timestamp()*1000)}"
        doc = {
            "room_id": rid,
            "room_number": room_number,
            "room_type": room_type,
            "capacity": capacity,
            "building": building,
            "campus_id": campus_id,
            "status": "available",
            "created_at": now(),
            "updated_at": now(),
        }

        # ↓↓↓ STAYS **INSIDE** addRoom ↓↓↓
        await db[COL_ROOMS].insert_one(doc)

        # --- Seed initial availability so defaults are recorded once ---
        campus_name = campus.get("campus_name", "")
        seed_days = default_open_days_for_campus(campus_name)
        seed_docs = []
        for d in seed_days:
            day_code = denormalize_day(d)
            for tb in TIME_BANDS:
                st, et = parse_band(tb)
                seed_docs.append({
                    "schedule_id": f"AVAIL-{rid}-{day_code}-{st}-{et}",
                    "day": day_code,
                    "start_time": st,
                    "end_time": et,
                    "room_id": rid,
                    "created_at": now(),
                    "updated_at": now(),
                })
        if seed_docs:
            await db[COL_SCHEDS].insert_many(seed_docs, ordered=False)

        return {"ok": True, "room_id": rid}

    if action == "updateRoom":
        room_id = (payload.get("room_id") or "").strip()
        if not room_id:
            raise HTTPException(status_code=400, detail="room_id is required.")
        updates: Dict[str, Any] = {}
        if "capacity" in payload:
            updates["capacity"] = int(payload["capacity"])
        if "room_type" in payload:
            updates["room_type"] = normalize_room_type(payload.get("room_type") or "")
            if updates["room_type"] not in ALLOWED_ROOM_TYPES:
                raise HTTPException(status_code=400, detail="room_type must be 'Classroom' or 'ComLab'.")
        if "status" in payload:
            updates["status"] = (payload.get("status") or "").strip()
        if not updates:
            return {"ok": True, "modified": 0}
        updates["updated_at"] = now()
        r = await db[COL_ROOMS].update_one({"room_id": room_id, "campus_id": campus_id}, {"$set": updates})
        return {"ok": True, "modified": r.modified_count}

    if action == "setAvailability":
        room_id = (payload.get("room_id") or "").strip()
        day_full = (payload.get("day") or "").strip()
        if day_full not in DOW:
            raise HTTPException(status_code=400, detail="Invalid day.")
        sel_bands: List[str] = payload.get("time_bands") or []
        for tb in sel_bands:
            if tb not in TIME_BANDS:
                raise HTTPException(status_code=400, detail="Only standard time slots are allowed.")
        st_pairs: Set[Tuple[str, str]] = {parse_band(tb) for tb in sel_bands}

        existing_docs = [
            x async for x in db[COL_SCHEDS].find(
                {
                    "room_id": room_id,
                    "section_id": {"$exists": False},
                    "day": {"$in": day_aliases(day_full)},
                },
                {"_id": 0, "schedule_id": 1, "start_time": 1, "end_time": 1},
            )
        ]

        existing_norm: Set[Tuple[str, str]] = set()
        ids_by_norm: Dict[Tuple[str, str], List[str]] = {}
        for e_doc in existing_docs:
            st0 = _t4(e_doc.get("start_time"))
            et0 = _t4(e_doc.get("end_time"))
            if st0 and et0:
                key = (st0, et0)
                existing_norm.add(key)
                sid0 = e_doc.get("schedule_id")
                if sid0:
                    ids_by_norm.setdefault(key, []).append(sid0)

        selected_norm = set(st_pairs)

        # Add newly-selected bands that don't exist yet (store canonical HHMM)
        to_add = selected_norm - existing_norm
        add_docs: List[Dict[str, Any]] = []
        day_code = denormalize_day(day_full)
        for (st, et) in to_add:
            add_docs.append(
                {
                    "schedule_id": f"AVAIL-{room_id}-{day_code}-{st}-{et}",
                    "day": day_code,
                    "start_time": st,
                    "end_time": et,
                    "room_id": room_id,
                    "created_at": now(),
                    "updated_at": now(),
                }
            )
        if add_docs:
            await db[COL_SCHEDS].insert_many(add_docs)

        # Remove bands that were unselected (delete by schedule_id so legacy time formats still delete)
        to_remove = existing_norm - selected_norm
        remove_ids: List[str] = []
        for key in to_remove:
            remove_ids += ids_by_norm.get(key, [])
        if remove_ids:
            await db[COL_SCHEDS].delete_many({"schedule_id": {"$in": remove_ids}})

        return {"ok": True, "added": len(to_add), "removed": len(remove_ids)}

    if action == "assign":
        room_id = (payload.get("room_id") or "").strip()
        section_id = (payload.get("section_id") or "").strip()
        day_full = (payload.get("day") or "").strip()
        time_band = (payload.get("time_band") or "").strip()
        if not (room_id and section_id and day_full and time_band):
            raise HTTPException(status_code=400, detail="room_id, section_id, day, time_band are required.")
        if day_full not in DOW:
            raise HTTPException(status_code=400, detail="Invalid day.")
        if time_band not in TIME_BANDS:
            raise HTTPException(status_code=400, detail="Time band must be one of the standard slots.")
        st, et = parse_band(time_band)

        # room must belong to this campus
        r = await db[COL_ROOMS].find_one(
            {"room_id": room_id, "campus_id": campus_id},
            {"_id": 0, "room_id": 1, "room_type": 1, "capacity": 1},
        )
        if not r:
            raise HTTPException(status_code=404, detail="Room not found in your campus.")

        # section in scoped term
        sec = await db[COL_SECTIONS].find_one(
            {"section_id": section_id, "term_id": term_id},
            {
                "_id": 0,
                "section_id": 1,
                "section_code": 1,
                "course_id": 1,
                "enrollment_cap": 1,
            },
        )

        if not sec:
            raise HTTPException(status_code=404, detail="Section not in active term.")

        # enforce campus prefix and college scope if available
        sec_code = (sec.get("section_code") or "").upper()
        if sec_prefix and not sec_code.startswith(sec_prefix):
            raise HTTPException(status_code=403, detail="Section not in your campus scope.")

        course = None
        if sec.get("course_id"):
            course = await db[COL_COURSES].find_one(
                {"course_id": sec.get("course_id")},
                {"_id": 0, "college_id": 1, "room_type": 1},
            )

        if college_id and course and course.get("college_id") and course["college_id"] != college_id:
            raise HTTPException(status_code=403, detail="Section not in your college scope.")

        # must have a schedule at that slot (normalize time values)
        sched = None
        async for cand in db[COL_SCHEDS].find(
            {"section_id": section_id, "day": {"$in": day_aliases(day_full)}},
            {"_id": 0, "schedule_id": 1, "day": 1, "start_time": 1, "end_time": 1, "room_type": 1},
        ):
            if _t4(cand.get("start_time")) == st and _t4(cand.get("end_time")) == et:
                sched = cand
                break
        if not sched:
            raise HTTPException(status_code=404, detail="Section has no schedule at this day/time.")

        # --- enforce room availability rules (same as Course Offerings eligibleRooms) ---
        avail_pairs: Set[Tuple[str, str]] = set()
        async for a in db[COL_SCHEDS].find(
            {"room_id": room_id, "section_id": {"$exists": False}, "day": {"$in": day_aliases(day_full)}},
            {"_id": 0, "start_time": 1, "end_time": 1},
        ):
            st0 = _t4(a.get("start_time"))
            et0 = _t4(a.get("end_time"))
            if st0 and et0:
                avail_pairs.add((st0, et0))

        default_days = default_open_days_for_campus(campus.get("campus_name", ""))
        if avail_pairs:
            if (st, et) not in avail_pairs:
                raise HTTPException(status_code=400, detail="Room is not available for this day/time.")
        else:
            if day_full not in default_days:
                raise HTTPException(status_code=400, detail="Room is not available for this day/time.")

        # --- enforce capacity & room_type compatibility ---

        # capacity check: sections.enrollment_cap must fit rooms.capacity
        room_cap = int(r.get("capacity") or 0)
        sec_cap_raw = sec.get("enrollment_cap")
        try:
            sec_cap = int(sec_cap_raw) if sec_cap_raw not in (None, "") else 0
        except Exception:
            sec_cap = 0

        if room_cap and sec_cap and room_cap < sec_cap:
            raise HTTPException(
                status_code=400,
                detail="Section enrollment cap exceeds room capacity.",
            )

        # room_type check: prefer section_schedules.room_type, fallback to course.room_type
        room_rt = normalize_room_type(_first_str(r.get("room_type")) or "")

        sched_rt = ""
        if sched.get("room_type"):
            sched_rt = normalize_room_type(_first_str(sched.get("room_type")) or "")

        course_rt = ""
        if course and course.get("room_type"):
            v = course.get("room_type")
            if isinstance(v, list) and v:
                course_rt = normalize_room_type(v[0])
            elif isinstance(v, str):
                course_rt = normalize_room_type(v)

        needed_rt = sched_rt or course_rt
        if needed_rt and room_rt and needed_rt != room_rt:
            raise HTTPException(
                status_code=400,
                detail="Room type is not compatible with the section's required room type.",
            )

                # prevent double-booking of the room (OVERLAP logic), but only against sections
        # that belong to the SAME term we are planning for
        overlaps: List[str] = []
        async for x in db[COL_SCHEDS].find(
            {
                "room_id": room_id,
                "section_id": {"$exists": True},
                "day": {"$in": day_aliases(day_full)},
            },
            {"_id": 0, "schedule_id": 1, "section_id": 1, "start_time": 1, "end_time": 1},
        ):
            other_sid = (x.get("section_id") or "").strip()
            if not other_sid or other_sid == section_id:
                continue
            if x.get("schedule_id") == sched.get("schedule_id"):
                continue
            st0 = _t4(x.get("start_time"))
            et0 = _t4(x.get("end_time"))
            if not (st0 and et0):
                continue
            if int(st0) < int(et) and int(et0) > int(st):
                overlaps.append(other_sid)

        if overlaps:
            other_sec_ids = sorted(list(set(overlaps)))
            in_same_term = await db[COL_SECTIONS].find_one(
                {"section_id": {"$in": other_sec_ids}, "term_id": term_id},
                {"_id": 1},
            )
            if in_same_term:
                raise HTTPException(status_code=400, detail="Room already assigned at this day/time.")

        await db[COL_SCHEDS].update_one(
            {"schedule_id": sched["schedule_id"]}, {"$set": {"room_id": room_id, "updated_at": now()}}
        )

        # Notify OM when rooms were assigned (for OM-created pending rows).
        # Must stay inside the "assign" action; otherwise other actions (e.g. unassign)
        # can crash because section_id/sched aren't defined in those branches.
        try:
            snap = await db["sections_submitted"].find_one(
                {"section_id": section_id, "term_id": term_id},
                {"_id": 0, "om_created_by": 1},
            ) or {}
            om_uid = (snap.get("om_created_by") or "").strip()
            if om_uid:
                room_doc = await db[COL_ROOMS].find_one(
                    {"room_id": room_id},
                    {"_id": 0, "room_number": 1, "building": 1},
                ) or {}
                rn = (room_doc.get("room_number") or "").strip() or room_id
                bld = (room_doc.get("building") or "").strip()
                where = f"{bld} {rn}".strip() if bld else rn
                await create_notification(
                    user_id=om_uid,
                    title="Rooms Assigned",
                    details=f"APO assigned room {where} for {sec_code} ({day_full} {time_band}).",
                    meta={
                        "route": "/om/load-assignment",
                        "kind": "apo_room_assigned",
                        "section_id": section_id,
                        "term_id": term_id,
                        "room_id": room_id,
                    },
                    send_email=False,
                )
        except Exception:
            pass

        return {"ok": True, "schedule_id": sched["schedule_id"]}

    if action == "unassign":
        room_id = (payload.get("room_id") or "").strip()
        section_id = (payload.get("section_id") or "").strip()
        day_full = (payload.get("day") or "").strip()
        time_band = (payload.get("time_band") or "").strip()
        if not (room_id and section_id and day_full and time_band):
            raise HTTPException(status_code=400, detail="room_id, section_id, day, time_band are required.")
        if day_full not in DOW:
            raise HTTPException(status_code=400, detail="Invalid day.")
        if time_band not in TIME_BANDS:
            raise HTTPException(status_code=400, detail="Time band must be one of the standard slots.")

        st, et = parse_band(time_band)

        sched = None
        async for cand in db[COL_SCHEDS].find(
            {"section_id": section_id, "room_id": room_id, "day": {"$in": day_aliases(day_full)}},
            {"_id": 0, "schedule_id": 1, "start_time": 1, "end_time": 1},
        ):
            if _t4(cand.get("start_time")) == st and _t4(cand.get("end_time")) == et:
                sched = cand
                break
        if not sched:
            raise HTTPException(status_code=404, detail="Assigned schedule not found.")

        await db[COL_SCHEDS].update_one(
            {"schedule_id": sched["schedule_id"]}, {"$set": {"room_id": None, "updated_at": now()}}
        )
        return {"ok": True, "schedule_id": sched["schedule_id"]}

    if action == "removeRoom":
        room_id = (payload.get("room_id") or "").strip()
        if not room_id:
            raise HTTPException(status_code=400, detail="room_id is required.")
        room = await db[COL_ROOMS].find_one({"room_id": room_id, "campus_id": campus_id}, {"_id": 0, "room_id": 1})
        if not room:
            raise HTTPException(status_code=404, detail="Room not found in your campus.")
        unassign_res = await db[COL_SCHEDS].update_many(
            {"room_id": room_id, "section_id": {"$exists": True}},
            {"$set": {"room_id": None, "updated_at": now()}},
        )
        delete_avail_res = await db[COL_SCHEDS].delete_many({"room_id": room_id, "section_id": {"$exists": False}})
        delete_room_res = await db[COL_ROOMS].delete_one({"room_id": room_id, "campus_id": campus_id})
        return {
            "ok": True,
            "unassigned": unassign_res.modified_count,
            "deleted_availability": delete_avail_res.deleted_count,
            "deleted_rooms": delete_room_res.deleted_count,
        }

    raise HTTPException(status_code=400, detail="Invalid action.")
