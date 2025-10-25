from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple, Literal
from fastapi import APIRouter, HTTPException, Query, Body
from ..main import db

router = APIRouter(prefix="/apo", tags=["apo"])

# ---- collections (as in animoassign_seed.js) ----
COL_ROOMS = "rooms"
COL_CAMPUSES = "campuses"
COL_TERMS = "terms"
COL_SECTIONS = "sections"
COL_SCHEDS = "section_schedules"
COL_COURSES = "courses"
COL_USER_ROLES = "user_roles"
COL_DEPARTMENTS = "departments"
COL_PRECOUNT = "preenlistment_count"
COL_FAC_ASSIGN = "faculty_assignments"
COL_FAC_LOADS = "faculty_loads"
COL_FAC_PROFILES = "faculty_profiles"
COL_USERS = "users"

DOW = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

# Standard time bands (single source of truth)
TIME_BANDS = [
    "07:30 – 09:00",
    "09:15 – 10:45",
    "11:00 – 12:30",
    "12:45 – 14:15",
    "14:30 – 16:00",
    "16:15 – 17:45",
    "18:00 – 19:30",
]

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

async def active_term_id() -> Optional[str]:
    t = await db[COL_TERMS].find_one({"status": "active"}, {"_id": 0, "term_id": 1})
    return t["term_id"] if t else None

async def apo_campus_id(user_id: str) -> Optional[str]:
    # Prefer campus derived from the APO's pre-enlistment rows; else fall back to department campus.
    row = await db[COL_PRECOUNT].find_one(
        {"user_id": user_id, "is_archived": {"$ne": True}},
        {"_id": 0, "campus_id": 1},
    )
    if row and row.get("campus_id"):
        return row["campus_id"]
    role = await db[COL_USER_ROLES].find_one(
        {"user_id": user_id, "role_type": "apo", "is_active": True},
        {"_id": 0, "department_id": 1},
    )
    if role and role.get("department_id"):
        dept = await db[COL_DEPARTMENTS].find_one(
            {"department_id": role["department_id"]}, {"_id": 0, "campus_id": 1}
        )
        if dept and dept.get("campus_id"):
            return dept["campus_id"]
    return None

async def campus_meta(campus_id: Optional[str]) -> Dict[str, str]:
    if not campus_id:
        return {"campus_id": "", "campus_name": ""}
    c = await db[COL_CAMPUSES].find_one(
        {"campus_id": campus_id}, {"_id": 0, "campus_id": 1, "campus_name": 1}
    )
    return c or {"campus_id": campus_id, "campus_name": ""}

async def sections_map(term_id: str) -> Dict[str, Dict[str, Any]]:
    """
    section_id -> { section_id, section_code, course_id, course_code }
    course_code is enriched from courses table (first code if it's an array)
    """
    out: Dict[str, Dict[str, Any]] = {}
    cursor = db[COL_SECTIONS].find(
        {"term_id": term_id},
        {"_id": 0, "section_id": 1, "section_code": 1, "course_id": 1},
    )
    secs = [s async for s in cursor]
    cids = [s["course_id"] for s in secs if s.get("course_id")]
    code_map: Dict[str, str] = {}
    if cids:
        cc = db[COL_COURSES].find(
            {"course_id": {"$in": list(set(cids))}},
            {"_id": 0, "course_id": 1, "course_code": 1},
        )
        for c in [x async for x in cc]:
            v = c.get("course_code")
            code_map[c["course_id"]] = v[0] if isinstance(v, list) and v else (v if isinstance(v, str) else "")
    for s in secs:
        out[s["section_id"]] = {
            "section_id": s["section_id"],
            "section_code": s.get("section_code", ""),
            "course_id": s.get("course_id", ""),
            "course_code": code_map.get(s.get("course_id", ""), ""),
        }
    return out

async def faculty_by_section_first(sec_ids: List[str], term_id: str) -> Dict[str, Dict[str, str]]:
    """
    section_id -> {faculty_id, user_id, faculty_name}
    Uses the first assignment found for the active term.
    """
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
    name_by_uid = {
        u["user_id"]: f'{u.get("first_name","")} {u.get("last_name","")}'.strip() for u in users
    }

    out: Dict[str, Dict[str, str]] = {}
    for r in rows:
        sid, fid = r["section_id"], r.get("faculty_id", "")
        if sid in out:
            continue  # keep first
        uid = uid_by_fid.get(fid, "")
        out[sid] = {"faculty_id": fid, "user_id": uid, "faculty_name": name_by_uid.get(uid, "")}
    return out

@router.get("/roomallocation")
async def get_room_allocation(userId: str = Query(..., min_length=3)):
    term_id = await active_term_id()
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

    campus_id = await apo_campus_id(userId)
    campus = await campus_meta(campus_id)

    # rooms for this campus
    rooms_cur = db[COL_ROOMS].find(
        {"campus_id": campus_id},
        {
            "_id": 0,
            "room_id": 1,
            "room_number": 1,
            "room_type": 1,
            "capacity": 1,
            "building": 1,
            "campus_id": 1,
            "status": 1,
        },
    )
    rooms = [r async for r in rooms_cur]
    room_ids = {r["room_id"] for r in rooms}

    # sections map (course_code enriched)
    s_map = await sections_map(term_id)
    sec_ids = list(s_map.keys())

    # courses so FE can build a fallback map
    course_ids = sorted({v.get("course_id", "") for v in s_map.values() if v.get("course_id")})
    courses = []
    if course_ids:
        cc = db[COL_COURSES].find(
            {"course_id": {"$in": course_ids}}, {"_id": 0, "course_id": 1, "course_code": 1}
        )
        courses = [x async for x in cc]

    # section schedules (with time_band)
    sched_cur = db[COL_SCHEDS].find(
        {"section_id": {"$in": sec_ids}},
        {
            "_id": 0,
            "schedule_id": 1,
            "section_id": 1,
            "day": 1,
            "start_time": 1,
            "end_time": 1,
            "room_id": 1,
        },
    )
    section_scheds_raw = [s async for s in sched_cur]
    section_scheds = [
        {
            **s,
            "time_band": band_of(s.get("start_time", ""), s.get("end_time", "")),
        }
        for s in section_scheds_raw
    ]

    # availability placeholders (only for rooms we manage)
    avail_cur = db[COL_SCHEDS].find(
        {"room_id": {"$in": list(room_ids)}, "section_id": {"$exists": False}},
        {"_id": 0, "schedule_id": 1, "day": 1, "start_time": 1, "end_time": 1, "room_id": 1},
    )
    availability = [a async for a in avail_cur if a.get("room_id") in room_ids]

    # faculty map (first) per section
    fac_map_first = await faculty_by_section_first(sec_ids, term_id)

    # prebuild dictionary of cells for quick updates
    schedule_by_room: Dict[str, Dict[Tuple[str, str], Dict[str, Any]]] = {}
    for r in rooms:
        rid = r["room_id"]
        schedule_by_room[rid] = {(d, tb): {"day": d, "time_band": tb, "section_id": None} for d in DOW for tb in TIME_BANDS}

    # mark allowed placeholders (presence in availability marks the key as allowed;
    # the cell already exists in schedule_by_room, we keep section_id=None)
    for a in availability:
        rid = a["room_id"]
        if rid not in schedule_by_room:
            continue
        key = (a.get("day", ""), band_of(a.get("start_time", ""), a.get("end_time", "")))
        if key in schedule_by_room[rid]:
            # no change needed; keeping the cell is the "allowed" signal
            pass

    # place assigned rows; skip orphan room_ids like ROOM007/ROOM013
    for s in section_scheds_raw:
        rid = s.get("room_id")
        if not rid or rid not in schedule_by_room:
            continue
        key = (s.get("day", ""), band_of(s.get("start_time", ""), s.get("end_time", "")))
        if key not in schedule_by_room[rid]:
            continue
        schedule_by_room[rid][key] = {
            "day": key[0],
            "time_band": key[1],
            "section_id": s["section_id"],
        }

    # compute which keys are allowed per room (availability OR assigned)
    def allowed_cells_for_room(rid: str) -> List[Dict[str, Any]]:
        allowed_keys = set()
        for a in availability:
            if a["room_id"] == rid:
                allowed_keys.add((a.get("day", ""), band_of(a.get("start_time", ""), a.get("end_time", ""))))
        for s in section_scheds_raw:
            if s.get("room_id") == rid:
                allowed_keys.add((s.get("day", ""), band_of(s.get("start_time", ""), s.get("end_time", ""))))
        cells = []
        for (d, tb), cell in schedule_by_room[rid].items():
            if (d, tb) in allowed_keys:
                cells.append(cell)
        return cells

    buildings = sorted(list({r.get("building", "") for r in rooms if r.get("building")}))

    rooms_out = []
    for r in rooms:
        rid = r["room_id"]
        rooms_out.append({
            "room_id": rid,
            "room_number": r["room_number"],
            "room_type": r.get("room_type", ""),
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
        "sectionSchedules": section_scheds,  # includes time_band
        "facultyBySection": fac_map_first,   # section_id -> {faculty_id,user_id,faculty_name}
        "courses": courses,                  # for FE fallback mapping
    }

@router.post("/roomallocation")
async def post_room_allocation(
    userId: str = Query(..., min_length=3),
    action: Literal["addRoom", "updateRoom", "setAvailability", "assign", "unassign", "removeRoom"] = Query(...),
    payload: Dict[str, Any] = Body(...)
):
    term_id = await active_term_id()
    if not term_id:
        raise HTTPException(status_code=400, detail="No active term.")
    campus_id = await apo_campus_id(userId)
    if not campus_id:
        raise HTTPException(status_code=400, detail="Unable to resolve APO campus.")

    if action == "addRoom":
        building = (payload.get("building") or "").strip()
        room_number = (payload.get("room_number") or "").strip()
        room_type = (payload.get("room_type") or "").strip()
        capacity = int(payload.get("capacity", 0) or 0)
        if not (building and room_number and room_type and capacity > 0):
            raise HTTPException(status_code=400, detail="Missing or invalid room fields.")
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
            updates["room_type"] = (payload.get("room_type") or "").strip()
        if "status" in payload:
            updates["status"] = (payload.get("status") or "").strip()
        if not updates:
            return {"ok": True, "modified": 0}
        updates["updated_at"] = now()
        r = await db[COL_ROOMS].update_one({"room_id": room_id, "campus_id": campus_id}, {"$set": updates})
        return {"ok": True, "modified": r.modified_count}

    if action == "setAvailability":
        room_id = (payload.get("room_id") or "").strip()
        day = (payload.get("day") or "").strip()
        sel_bands: List[str] = payload.get("time_bands") or []
        if day not in DOW:
            raise HTTPException(status_code=400, detail="Invalid day.")
        for tb in sel_bands:
            if tb not in TIME_BANDS:
                raise HTTPException(status_code=400, detail="Only standard time slots are allowed.")

        wanted_pairs = {parse_band(tb) for tb in sel_bands}
        existing_cur = db[COL_SCHEDS].find(
            {"room_id": room_id, "day": day, "section_id": {"$exists": False}},
            {"_id": 0, "start_time": 1, "end_time": 1},
        )
        existing_pairs = {(e["start_time"], e["end_time"]) for e in [x async for x in existing_cur]}

        to_add = wanted_pairs - existing_pairs
        add_docs = []
        for (st, et) in to_add:
            add_docs.append({
                "schedule_id": f"AVAIL-{room_id}-{day}-{st}-{et}",
                "day": day,
                "start_time": st,
                "end_time": et,
                "room_id": room_id,
                "created_at": now(),
                "updated_at": now(),
            })
        if add_docs:
            await db[COL_SCHEDS].insert_many(add_docs)

        to_remove = existing_pairs - wanted_pairs
        if to_remove:
            cond = [{"start_time": st, "end_time": et} for (st, et) in to_remove]
            await db[COL_SCHEDS].delete_many({
                "room_id": room_id,
                "day": day,
                "section_id": {"$exists": False},
                "$or": cond
            })
        return {"ok": True, "added": len(to_add), "removed": len(to_remove)}

    if action == "assign":
        room_id = (payload.get("room_id") or "").strip()
        section_id = (payload.get("section_id") or "").strip()
        day = (payload.get("day") or "").strip()
        time_band = (payload.get("time_band") or "").strip()
        if not (room_id and section_id and day and time_band):
            raise HTTPException(status_code=400, detail="room_id, section_id, day, time_band are required.")
        if day not in DOW:
            raise HTTPException(status_code=400, detail="Invalid day.")
        if time_band not in TIME_BANDS:
            raise HTTPException(status_code=400, detail="Time band must be one of the standard slots.")

        st, et = parse_band(time_band)

        # room in campus?
        r = await db[COL_ROOMS].find_one({"room_id": room_id, "campus_id": campus_id}, {"_id": 0, "room_id": 1})
        if not r:
            raise HTTPException(status_code=404, detail="Room not found in your campus.")

        # placeholder must exist for availability
        ph = await db[COL_SCHEDS].find_one(
            {"room_id": room_id, "day": day, "start_time": st, "end_time": et, "section_id": {"$exists": False}},
            {"_id": 0, "schedule_id": 1},
        )
        if not ph:
            raise HTTPException(status_code=400, detail="Room not configured for this day/time.")

        # section must have that official schedule
        sec = await db[COL_SECTIONS].find_one({"section_id": section_id, "term_id": term_id}, {"_id": 0, "section_id": 1})
        if not sec:
            raise HTTPException(status_code=404, detail="Section not in active term.")
        sched = await db[COL_SCHEDS].find_one(
            {"section_id": section_id, "day": day, "start_time": st, "end_time": et},
            {"_id": 0, "schedule_id": 1},
        )
        if not sched:
            raise HTTPException(status_code=404, detail="Section has no schedule at this day/time.")

        await db[COL_SCHEDS].update_one(
            {"schedule_id": sched["schedule_id"]}, {"$set": {"room_id": room_id, "updated_at": now()}}
        )
        return {"ok": True, "schedule_id": sched["schedule_id"]}

    if action == "unassign":
        room_id = (payload.get("room_id") or "").strip()
        section_id = (payload.get("section_id") or "").strip()
        day = (payload.get("day") or "").strip()
        time_band = (payload.get("time_band") or "").strip()
        if not (room_id and section_id and day and time_band):
            raise HTTPException(status_code=400, detail="room_id, section_id, day, time_band are required.")
        if day not in DOW:
            raise HTTPException(status_code=400, detail="Invalid day.")
        if time_band not in TIME_BANDS:
            raise HTTPException(status_code=400, detail="Time band must be one of the standard slots.")

        st, et = parse_band(time_band)
        sched = await db[COL_SCHEDS].find_one(
            {"section_id": section_id, "day": day, "start_time": st, "end_time": et, "room_id": room_id},
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

        room = await db[COL_ROOMS].find_one(
            {"room_id": room_id, "campus_id": campus_id},
            {"_id": 0, "room_id": 1}
        )
        if not room:
            raise HTTPException(status_code=404, detail="Room not found in your campus.")

        # Unassign any section schedules currently pointing to this room
        unassign_res = await db[COL_SCHEDS].update_many(
            {"room_id": room_id, "section_id": {"$exists": True}},
            {"$set": {"room_id": None, "updated_at": now()}}
        )

        # Delete availability placeholders (rows without section_id)
        delete_avail_res = await db[COL_SCHEDS].delete_many(
            {"room_id": room_id, "section_id": {"$exists": False}}
        )

        # Delete the room itself
        delete_room_res = await db[COL_ROOMS].delete_one(
            {"room_id": room_id, "campus_id": campus_id}
        )

        return {
            "ok": True,
            "unassigned": unassign_res.modified_count,
            "deleted_availability": delete_avail_res.deleted_count,
            "deleted_rooms": delete_room_res.deleted_count
        }

    raise HTTPException(status_code=400, detail="Invalid action.")
