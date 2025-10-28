# app/routes/apo.py
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple, Literal, Set
from fastapi import APIRouter, HTTPException, Query, Body
from ..main import db

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
    "TH": "Thursday", "THU": "Thursday", "THUR": "Thursday", "THURS": "Thursday", "THURSDAY": "Thursday",
    "H": "Thursday", "R": "Thursday",
    # Friday
    "F": "Friday", "FRI": "Friday", "FRIDAY": "Friday",
    # Saturday
    "S": "Saturday", "SAT": "Saturday", "SATURDAY": "Saturday",
}

DAY_NAME_TO_CODE = {
    "Monday": "M", "Tuesday": "T", "Wednesday": "W", "Thursday": "TH", "Friday": "F", "Saturday": "S"
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

def fmt_pair(s: str) -> str:
    s = str(s or "")
    if len(s) == 3:
        h, m = s[0], s[1:]
    else:
        h, m = s[:-2], s[-2:]
    return f"{int(h):02d}:{m}"

def band_of(start: str, end: str) -> str:
    return f"{fmt_pair(start)} – {fmt_pair(end)}"

def parse_band(band: str) -> Tuple[str, str]:
    try:
        a, b = [x.strip() for x in band.split("–")]
        sh, sm = [int(x) for x in a.split(":")]
        eh, em = [int(x) for x in b.split(":")]
        st = f"{sh}{sm:02d}".lstrip("0") or "0"
        et = f"{eh}{em:02d}".lstrip("0") or "0"
        return (st, et)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid time band (use HH:MM – HH:MM).")

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

def normalize_room_type(rt: str) -> str:
    u = (rt or "").strip().lower().replace(" ", "")
    if u in {"classroom", "class", "cr"}:
        return "Classroom"
    if u in {"comlab", "lab", "computerlab", "laboratory"}:
        return "ComLab"
    return (rt or "").strip()

def campus_section_prefix(campus_name: str) -> Optional[str]:
    n = (campus_name or "").lower()
    if "manila" in n or "taft" in n:
        return "S"
    if "laguna" in n or "canlubang" in n or "binan" in n or "biñan" in n:
        return "X"
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
        {"_id": 0, "section_id": 1, "section_code": 1, "course_id": 1},
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
        }
    return out

async def faculty_by_section_first(sec_ids: List[str], term_id: str) -> Dict[str, Dict[str, str]]:
    if not sec_ids:
        return {}
    loads_cur = db[COL_FAC_LOADS].find({"term_id": term_id}, {"_id": 0, "load_id": 1})
    load_ids = [x["load_id"] async for x in loads_cur]
    if not load_ids:
        return {}
    fa_cur = db[COL_FAC_ASSIGN].find(
        {"section_id": {"$in": sec_ids}, "load_id": {"$in": load_ids}, "is_archived": {"$ne": True}},
        {"_id": 0, "section_id": 1, "faculty_id": 1},
    )
    rows = [x async for x in fa_cur]
    fac_ids = list({r["faculty_id"] for r in rows if r.get("faculty_id")})
    if not fac_ids:
        return {}
    prof_cur = db[COL_FAC_PROFILES].find(
        {"faculty_id": {"$in": fac_ids}}, {"_id": 0, "faculty_id": 1, "user_id": 1}
    )
    profs = [x async for x in prof_cur]
    uid_by_fid = {p["faculty_id"]: p.get("user_id", "") for p in profs}
    uids = [u for u in uid_by_fid.values() if u]
    user_cur = db[COL_USERS].find(
        {"user_id": {"$in": uids}}, {"_id": 0, "user_id": 1, "first_name": 1, "last_name": 1}
    )
    users = [x async for x in user_cur]
    name_by_uid = {u["user_id"]: f'{u.get("first_name","")} {u.get("last_name","")}'.strip() for u in users}
    out: Dict[str, Dict[str, str]] = {}
    for r in rows:
        sid, fid = r["section_id"], r.get("faculty_id", "")
        if sid in out:
            continue
        uid = uid_by_fid.get(fid, "")
        out[sid] = {"faculty_id": fid, "user_id": uid, "faculty_name": name_by_uid.get(uid, "")}
    return out

@router.get("/roomallocation")
async def get_room_allocation(userId: str = Query(..., min_length=3)):
    term_id = await resolve_term_id_with_sections_fallback()
    if not term_id:
        return {
            "campus": {"campus_id": "", "campus_name": ""},
            "term_id": "",
            "buildings": [],
            "timeBands": TIME_BANDS,
            "rooms": [],
            "sections": [],
            "sectionSchedules": [],
            "facultyBySection": {},
            "courses": [],
        }

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
    if course_ids:
        cc = db[COL_COURSES].find(
            {"course_id": {"$in": course_ids}},
            {"_id": 0, "course_id": 1, "course_code": 1, "college_id": 1},
        )
        courses = [x async for x in cc]

    # ---- schedules ----
    # 1) Schedules for in-scope sections (these drive the Allocate modal)
    fields = {"_id": 0, "schedule_id": 1, "section_id": 1, "day": 1, "start_time": 1, "end_time": 1, "room_id": 1}
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
    # keep only those whose section is NOT in scope (to avoid duplicates)
    assigned_out_of_scope = [x for x in assigned_norm if x.get("section_id") not in s_map]

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
    seen_keys = set()
    for s in section_scheds_for_grid:
        rid = s.get("room_id")
        if not rid or rid not in schedule_by_room:
            continue
        key = (s["day"], s["time_band"])
        seen_keys.add((rid, key))
        schedule_by_room[rid][key] = {"day": key[0], "time_band": key[1], "section_id": s.get("section_id")}

    # campus default open days
    default_open_days = default_open_days_for_campus(campus.get("campus_name", ""))

    def allowed_cells_for_room(rid: str) -> List[Dict[str, Any]]:
        allowed_keys = set()

        # always include already-assigned cells
        for s in section_scheds_for_grid:
            if s.get("room_id") == rid:
                allowed_keys.add((s["day"], s["time_band"]))

        # explicit availability placeholders
        for a in availability:
            if a["room_id"] == rid:
                allowed_keys.add((a["day"], a["time_band"]))

        # default campus open days
        for d in default_open_days:
            for tb in TIME_BANDS:
                allowed_keys.add((d, tb))

        out = []
        for k, cell in schedule_by_room[rid].items():
            if k in allowed_keys:
                c = dict(cell)
                c["allowed"] = True
                out.append(c)
        return out

    buildings = sorted(list({r.get("building", "") for r in rooms if r.get("building")}))

    rooms_out = []
    for r in rooms:
        rid = r["room_id"]
        rooms_out.append({
            "room_id": rid,
            "room_number": r["room_number"],
            "room_type": normalize_room_type(r.get("room_type", "")),
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
    term_id = await resolve_term_id_with_sections_fallback()
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
        await db[COL_ROOMS].insert_one(doc)
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
        st_pairs = {parse_band(tb) for tb in sel_bands}

        existing_cur = db[COL_SCHEDS].find(
            {
                "room_id": room_id,
                "section_id": {"$exists": False},
                "day": {"$in": day_aliases(day_full)},
            },
            {"_id": 0, "start_time": 1, "end_time": 1},
        )
        existing_pairs = {(e["start_time"], e["end_time"]) for e in [x async for x in existing_cur]}

        to_add = st_pairs - existing_pairs
        add_docs = []
        day_code = denormalize_day(day_full)
        for (st, et) in to_add:
            add_docs.append({
                "schedule_id": f"AVAIL-{room_id}-{day_code}-{st}-{et}",
                "day": day_code,
                "start_time": st,
                "end_time": et,
                "room_id": room_id,
                "created_at": now(),
                "updated_at": now(),
            })
        if add_docs:
            await db[COL_SCHEDS].insert_many(add_docs)

        to_remove = existing_pairs - st_pairs
        if to_remove:
            cond = [{"start_time": st, "end_time": et} for (st, et) in to_remove]
            await db[COL_SCHEDS].delete_many({
                "room_id": room_id,
                "section_id": {"$exists": False},
                "day": {"$in": day_aliases(day_full)},
                "$or": cond
            })
        return {"ok": True, "added": len(to_add), "removed": len(to_remove)}

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
        r = await db[COL_ROOMS].find_one({"room_id": room_id, "campus_id": campus_id}, {"_id": 0, "room_id": 1})
        if not r:
            raise HTTPException(status_code=404, detail="Room not found in your campus.")

        # section in scoped term
        sec = await db[COL_SECTIONS].find_one(
            {"section_id": section_id, "term_id": term_id},
            {"_id": 0, "section_id": 1, "section_code": 1, "course_id": 1},
        )
        if not sec:
            raise HTTPException(status_code=404, detail="Section not in active term.")

        # enforce campus prefix and college scope if available
        sec_code = (sec.get("section_code") or "").upper()
        if sec_prefix and not sec_code.startswith(sec_prefix):
            raise HTTPException(status_code=403, detail="Section not in your campus scope.")
        if college_id:
            course = await db[COL_COURSES].find_one(
                {"course_id": sec.get("course_id")}, {"_id": 0, "college_id": 1}
            )
            if course and course.get("college_id") and course["college_id"] != college_id:
                raise HTTPException(status_code=403, detail="Section not in your college scope.")

        # must have a schedule at that slot
        sched = await db[COL_SCHEDS].find_one(
            {"section_id": section_id, "day": {"$in": day_aliases(day_full)}, "start_time": st, "end_time": et},
            {"_id": 0, "schedule_id": 1},
        )
        if not sched:
            raise HTTPException(status_code=404, detail="Section has no schedule at this day/time.")

        # prevent double-booking of the room
        conflict = await db[COL_SCHEDS].find_one(
            {
                "section_id": {"$ne": section_id},
                "day": {"$in": day_aliases(day_full)},
                "start_time": st,
                "end_time": et,
                "room_id": room_id,
            },
            {"_id": 1},
        )
        if conflict:
            raise HTTPException(status_code=400, detail="Room already assigned at this day/time.")

        await db[COL_SCHEDS].update_one(
            {"schedule_id": sched["schedule_id"]}, {"$set": {"room_id": room_id, "updated_at": now()}}
        )
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
        sched = await db[COL_SCHEDS].find_one(
            {"section_id": section_id, "day": {"$in": day_aliases(day_full)}, "start_time": st, "end_time": et, "room_id": room_id},
            {"_id": 0, "schedule_id": 1},
        )
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
