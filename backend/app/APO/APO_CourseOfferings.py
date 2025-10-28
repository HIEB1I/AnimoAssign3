# app/routes/apo_course_offerings.py
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple, Literal
from fastapi import APIRouter, HTTPException, Query, UploadFile, File, Body
from ..main import db

router = APIRouter(prefix="/apo", tags=["apo"])

# ---- collections (align with your DB) ----
COL_TERMS = "terms"
COL_SECTIONS = "sections"
COL_SCHEDS = "section_schedules"
COL_COURSES = "courses"
COL_USERS = "users"
COL_DEPARTMENTS = "departments"
COL_PROGRAMS = "programs"
COL_BATCHES = "batches"
COL_FAC_PROFILES = "faculty_profiles"
COL_FAC_LOADS = "faculty_loads"
COL_FAC_ASSIGN = "faculty_assignments"
COL_ROOMS = "rooms"
COL_USER_ROLES = "user_roles"
COL_ROLE_ASSIGN = "role_assignments"
COL_OUTBOX = "outbox"
COL_PREEN = "preenlistment_count"  # counts for program_no sizing (capacity-driven)

# ---- constants / helpers ----
DOW = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

DAY_CODE_TO_NAME = {
    "M": "Monday", "MON": "Monday", "MONDAY": "Monday",
    "T": "Tuesday", "TU": "Tuesday", "TUE": "Tuesday", "TUESDAY": "Tuesday",
    "W": "Wednesday", "WED": "Wednesday", "WEDNESDAY": "Wednesday",
    "TH": "Thursday", "THU": "Thursday", "THUR": "Thursday", "THURS": "Thursday", "THURSDAY": "Thursday",
    "H": "Thursday", "R": "Thursday",
    "F": "Friday", "FRI": "Friday", "FRIDAY": "Friday",
    "S": "Saturday", "SAT": "Saturday", "SATURDAY": "Saturday",
}

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

def normalize_day(v: Any) -> str:
    if not v:
        return ""
    s = str(v).strip()
    if s in DOW:
        return s
    u = s.upper()
    return DAY_CODE_TO_NAME.get(u, s.title() if s.title() in DOW else s)

def campus_section_prefix_for_offerings(campus_name: str) -> Optional[str]:
    """
    IMPORTANT: Per your note:
    - S sections → MANILA
    - X sections → LAGUNA
    """
    n = (campus_name or "").lower()
    if "manila" in n or "taft" in n:
        return "S"
    if "laguna" in n or "canlubang" in n or "biñan" in n or "binan" in n:
        return "X"
    return None

async def resolve_term_id_with_sections_fallback() -> Optional[str]:
    t = await db[COL_TERMS].find_one({"is_current": True}, {"_id": 0, "term_id": 1})
    if t:
        tid = t["term_id"]
        c = await db[COL_SECTIONS].count_documents({"term_id": tid})
        if c > 0:
            return tid
    sec = await db[COL_SECTIONS].find({}, {"_id": 0, "term_id": 1, "updated_at": 1, "created_at": 1}) \
        .sort([("updated_at", -1), ("created_at", -1)]).limit(1).to_list(1)
    if sec:
        return sec[0].get("term_id")
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
    c = await db["campuses"].find_one(
        {"campus_id": campus_id}, {"_id": 0, "campus_id": 1, "campus_name": 1}
    )
    return c or {"campus_id": campus_id, "campus_name": ""}

def to_caps_name(user: Dict[str, Any]) -> str:
    first = (user.get("first_name") or "").strip()
    last = (user.get("last_name") or "").strip()
    mid = (user.get("middle_name") or "").strip()
    if mid:
        formatted = f"{last}, {first} {mid}".upper()
    else:
        formatted = f"{last}, {first}".upper()
    return formatted.strip().replace("  ", " ")

async def courses_map(course_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    if not course_ids:
        return out
    cur = db[COL_COURSES].find(
        {"course_id": {"$in": course_ids}},
        {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1,
         "department_id": 1, "program_level": 1}
    )
    for c in [x async for x in cur]:
        code = c.get("course_code")
        out[c["course_id"]] = {
            "course_code": code[0] if isinstance(code, list) and code else (code if isinstance(code, str) else ""),
            "course_title": c.get("course_title", ""),
            "department_id": c.get("department_id", ""),
            "program_level": c.get("program_level", ""),
        }
    return out

async def departments_map(dep_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    if not dep_ids:
        return out
    cur = db[COL_DEPARTMENTS].find(
        {"department_id": {"$in": dep_ids}},
        {"_id": 0, "department_id": 1, "department_name": 1}
    )
    for d in [x async for x in cur]:
        out[d["department_id"]] = d
    return out

async def batches_map() -> Dict[int, Dict[str, Any]]:
    out: Dict[int, Dict[str, Any]] = {}
    cur = db[COL_BATCHES].find({}, {"_id": 0, "batch_id": 1, "batch_number": 1, "batch_code": 1})
    for b in [x async for x in cur]:
        n = int(b.get("batch_number") or 0)
        if n:
            out[n] = b
    return out

async def faculty_by_section(term_id: str, section_ids: List[str]) -> Dict[str, Dict[str, str]]:
    """
    First-assigned faculty per section (same approach you used in room allocation).
    """
    out: Dict[str, Dict[str, str]] = {}
    if not section_ids:
        return out
    loads_cur = db[COL_FAC_LOADS].find({"term_id": term_id}, {"_id": 0, "load_id": 1})
    load_ids = [x["load_id"] async for x in loads_cur]
    if not load_ids:
        return out
    fa_cur = db[COL_FAC_ASSIGN].find(
        {"section_id": {"$in": section_ids}, "load_id": {"$in": load_ids}, "is_archived": {"$ne": True}},
        {"_id": 0, "section_id": 1, "faculty_id": 1},
    )
    rows = [x async for x in fa_cur]
    fac_ids = list({r["faculty_id"] for r in rows if r.get("faculty_id")})
    if not fac_ids:
        return out
    prof_cur = db[COL_FAC_PROFILES].find(
        {"faculty_id": {"$in": fac_ids}}, {"_id": 0, "faculty_id": 1, "user_id": 1}
    )
    profs = [x async for x in prof_cur]
    uid_by_fid = {p["faculty_id"]: p.get("user_id", "") for p in profs}
    uids = [u for u in uid_by_fid.values() if u]
    user_cur = db[COL_USERS].find(
        {"user_id": {"$in": uids}}, {"_id": 0, "user_id": 1, "first_name": 1, "middle_name": 1, "last_name": 1}
    )
    users = [x async for x in user_cur]
    name_by_uid = {u["user_id"]: to_caps_name(u) for u in users}
    for r in rows:
        sid, fid = r["section_id"], r.get("faculty_id", "")
        if sid in out:
            continue
        uid = uid_by_fid.get(fid, "")
        out[sid] = {"faculty_id": fid, "user_id": uid, "faculty_name": name_by_uid.get(uid, "")}
    return out

async def next_section_code_for_campus(prefix: str, term_id: str) -> str:
    """
    Find the next section code e.g. S11, S12... (or X11, X12...) for the term/prefix.
    Start at 11 if none exists.
    """
    if not prefix:
        return ""
    cur = db[COL_SECTIONS].find(
        {"term_id": term_id, "section_code": {"$regex": f"^{prefix}\\d+$", "$options": "i"}},
        {"_id": 0, "section_code": 1}
    )
    nums: List[int] = []
    for x in [y async for y in cur]:
        code = (x.get("section_code") or "").upper()
        try:
            nums.append(int(code[len(prefix):]))
        except Exception:
            pass
    nxt = max(nums) + 1 if nums else 11
    return f"{prefix}{nxt}"

async def preen_count_for_course(term_id: str, course_id: str, campus_id: Optional[str]) -> int:
    """
    Reads preenlistment_count for a course (optionally scoped by campus if present).
    The uploaded JSON shows varying shapes; we honor both (with or without campus).
    """
    cond: Dict[str, Any] = {"course_id": course_id}
    # common filters
    if term_id:
        cond["term_id"] = term_id
    # optional campus scoping if field exists
    if campus_id:
        # if campus_id or campus_name exists in docs, try to match
        count_by_campus = await db[COL_PREEN].count_documents({"course_id": course_id, "campus_id": campus_id})
        if count_by_campus > 0:
            cond["campus_id"] = campus_id
    total = 0
    async for row in db[COL_PREEN].find(cond, {"_id": 0, "preenlistment_count": 1, "count": 1}):
        total += int(row.get("preenlistment_count") or row.get("count") or 0)
    return total

def pick_first_two_schedules(scheds: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Normalize schedules into two slots for the UI: [slot1, slot2] by earliest start.
    """
    def to_int(t: str) -> int:
        t = str(t or "0")
        try:
            return int(t)
        except Exception:
            return 0

    ordered = sorted(scheds, key=lambda s: (normalize_day(s.get("day")), to_int(s.get("start_time"))))
    return ordered[:2]

# ===========================
# GET: list table + filter options
# ===========================
@router.get("/courseofferings")
async def get_course_offerings(
    userId: str = Query(..., min_length=3),
    level: Optional[str] = Query(None),
    department_id: Optional[str] = Query(None),
    batch_id: Optional[str] = Query(None),
    program_id: Optional[str] = Query(None),  # included for completeness even if not always present in sample data
):
    term_id = await resolve_term_id_with_sections_fallback()
    if not term_id:
        return {
            "campus": {"campus_id": "", "campus_name": ""},
            "term_id": "",
            "filters": {"levels": [], "departments": [], "ids": [], "programs": []},
            "rows": [],
        }

    campus_id, _college_id = await apo_scope(userId)
    if not campus_id:
        raise HTTPException(status_code=400, detail="Unable to resolve APO campus from role_assignments.")
    campus = await campus_meta(campus_id)
    sec_prefix = campus_section_prefix_for_offerings(campus.get("campus_name", ""))

    # Load sections for term, filtered by campus prefix
    sec_cond: Dict[str, Any] = {"term_id": term_id}
    if sec_prefix:
        sec_cond["section_code"] = {"$regex": f"^{sec_prefix}", "$options": "i"}

    # batch filter (sections store batch_number; batches store batch_id & batch_code)
    batch_by_number = await batches_map()
    batch_number_filter: Optional[int] = None
    if batch_id:
        b = await db[COL_BATCHES].find_one({"batch_id": batch_id}, {"_id": 0, "batch_number": 1})
        if b and b.get("batch_number") is not None:
            batch_number_filter = int(b["batch_number"])
            sec_cond["batch_number"] = batch_number_filter

    # fetch sections
    sec_fields = {
        "_id": 0,
        "section_id": 1,
        "section_code": 1,
        "course_id": 1,
        "term_id": 1,
        "enrollment_cap": 1,
        "remarks": 1,
        "batch_number": 1,
    }
    secs = [s async for s in db[COL_SECTIONS].find(sec_cond, sec_fields)]
    section_ids = [s["section_id"] for s in secs]
    course_ids = list({s["course_id"] for s in secs if s.get("course_id")})

    # join: courses + dept
    cmap = await courses_map(course_ids)
    dep_ids = list({cmap[c]["department_id"] for c in cmap if cmap[c].get("department_id")})
    dmap = await departments_map(dep_ids)

    # program filter (if your data has course.program_id; if not present, this filter is simply ignored)
    if program_id:
        # only keep sections whose course has program_id == program_id (if field exists)
        filtered = []
        for s in secs:
            c = cmap.get(s.get("course_id", ""))
            if not c:
                continue
            if "program_id" in c and c.get("program_id") != program_id:
                continue
            filtered.append(s)
        secs = filtered
        section_ids = [s["section_id"] for s in secs]

    # level / department filter application
    if level:
        secs = [s for s in secs if cmap.get(s.get("course_id", ""), {}).get("program_level") == level]
        section_ids = [s["section_id"] for s in secs]
    if department_id:
        secs = [s for s in secs if cmap.get(s.get("course_id", ""), {}).get("department_id") == department_id]
        section_ids = [s["section_id"] for s in secs]

    # fetch schedules for those sections
    sched_fields = {"_id": 0, "schedule_id": 1, "section_id": 1, "day": 1, "start_time": 1, "end_time": 1, "room_id": 1}
    scheds = [x async for x in db[COL_SCHEDS].find({"section_id": {"$in": section_ids}}, sched_fields)]
    scheds_by_sec: Dict[str, List[Dict[str, Any]]] = {}
    for sc in scheds:
        sid = sc.get("section_id")
        scheds_by_sec.setdefault(sid, []).append(sc)

    # faculty per section
    f_by_section = await faculty_by_section(term_id, section_ids)

    # optional rooms map (for room_type)
    room_ids = list({sc.get("room_id") for sc in scheds if sc.get("room_id")})
    rmap: Dict[str, Dict[str, Any]] = {}
    if room_ids:
        cur = db[COL_ROOMS].find(
            {"room_id": {"$in": room_ids}},
            {"_id": 0, "room_id": 1, "room_type": 1, "capacity": 1, "building": 1}
        )
        for r in [x async for x in cur]:
            rmap[r["room_id"]] = r

    rows = []
    # Preenlistment count cache to avoid repeated reads
    preen_cache: Dict[str, int] = {}

    for s in secs:
        cid = s.get("course_id", "")
        cinfo = cmap.get(cid, {})
        dep_name = dmap.get(cinfo.get("department_id", ""), {}).get("department_name", "")

        # schedules → first two
        picked = pick_first_two_schedules(scheds_by_sec.get(s["section_id"], []))
        slot1, slot2 = (picked[0] if len(picked) >= 1 else None), (picked[1] if len(picked) >= 2 else None)

        # map rooms for slot1/slot2 (room_type)
        def slot_payload(x: Optional[Dict[str, Any]]):
            if not x:
                return None
            rid = x.get("room_id")
            room = rmap.get(rid) if rid else None
            return {
                "day": normalize_day(x.get("day")),
                "start_time": x.get("start_time", ""),
                "end_time": x.get("end_time", ""),
                "room_id": rid or "",
                "room_type": (room or {}).get("room_type", "") if room else "",
            }

        # faculty
        ff = f_by_section.get(s["section_id"], {})
        fac_name = ff.get("faculty_name", "") or "UNASSIGNED"

        # program_no (computed per course via preenlistment_count)
        if cid not in preen_cache:
            preen_cache[cid] = await preen_count_for_course(term_id, cid, campus_id)
        total_intent = preen_cache[cid]  # students intending to take this course (campus-scoped if possible)

        # capacity fallback: if enrollment_cap absent, try room1 capacity → else 40
        cap = int(s.get("enrollment_cap") or 0)
        if cap <= 0 and slot1 and slot1.get("room_id") and slot1["room_id"] in rmap:
            cap = int(rmap[slot1["room_id"]].get("capacity") or 40)
        if cap <= 0:
            cap = 40

        # How many sections "should" exist for this course (rough sizing only, not persisted)
        needed = (total_intent + cap - 1) // cap if total_intent > 0 else None

        # We'll compute "program_no" on the FE but also return "needed" so FE can show context
        row = {
            "batch": {
                "batch_number": s.get("batch_number"),
                "batch_id": (batch_by_number.get(int(s.get("batch_number") or 0), {}) or {}).get("batch_id", ""),
                "batch_code": (batch_by_number.get(int(s.get("batch_number") or 0), {}) or {}).get("batch_code", ""),
            },
            "program": {
                # courses in your sample don't always have program_id; we still return placeholder keys
                "program_id": cinfo.get("program_id", ""),
                "program_code": "",  # (if your data has it via join, fill here; left blank if not in dataset)
            },
            "course": {
                "course_id": cid,
                "course_code": cinfo.get("course_code", ""),
                "course_title": cinfo.get("course_title", ""),
                "program_level": cinfo.get("program_level", ""),
                "department_id": cinfo.get("department_id", ""),
                "department_name": dep_name,
            },
            "section": {
                "section_id": s["section_id"],
                "section_code": s.get("section_code", ""),
                "enrollment_cap": cap,
                "remarks": s.get("remarks", "") or "",
            },
            "faculty": {
                "faculty_id": ff.get("faculty_id", ""),
                "user_id": ff.get("user_id", ""),
                "faculty_name": fac_name,  # already CAPS
            },
            "slot1": slot_payload(slot1),
            "slot2": slot_payload(slot2),
            "sizing": {
                "preenlistment_total": total_intent,
                "suggested_sections": needed,
            },
        }
        rows.append(row)

    # ---- build filter options dynamically (no hard-coded lists) ----
    levels = sorted(list({cmap[c]["program_level"] for c in cmap if cmap[c].get("program_level")}))
    dep_opts = []
    for dep_id in sorted(list({cmap[c]["department_id"] for c in cmap if cmap[c].get("department_id")})):
        dep_opts.append({
            "department_id": dep_id,
            "department_name": dmap.get(dep_id, {}).get("department_name", ""),
        })

    # batch options (IDs)
    batch_opts = []
    for n, b in sorted(batch_by_number.items(), key=lambda z: z[0], reverse=True):
        batch_opts.append({"batch_id": b["batch_id"], "batch_code": b["batch_code"]})

    # program options: list all programs
    prog_opts = []
    async for pr in db[COL_PROGRAMS].find({}, {"_id": 0, "program_id": 1, "program_code": 1}):
        prog_opts.append(pr)

    return {
        "campus": campus,
        "term_id": term_id,
        "filters": {
            "levels": levels,
            "departments": dep_opts,
            "ids": batch_opts,
            "programs": prog_opts,
        },
        "rows": rows,
    }

# ===========================
# POST: actions (add/edit/delete/import/forward)
# ===========================
@router.post("/courseofferings")
async def post_course_offerings(
    userId: str = Query(..., min_length=3),
    action: Literal["addRow", "editRow", "deleteRow", "importCSV", "forward"] = Query(...),
    payload: Optional[Dict[str, Any]] = Body(None),
    file: Optional[UploadFile] = File(None),
):
    term_id = await resolve_term_id_with_sections_fallback()
    if not term_id:
        raise HTTPException(status_code=400, detail="No active term.")
    campus_id, _ = await apo_scope(userId)
    if not campus_id:
        raise HTTPException(status_code=400, detail="Unable to resolve APO campus from role_assignments.")
    campus = await campus_meta(campus_id)
    sec_prefix = campus_section_prefix_for_offerings(campus.get("campus_name", ""))

    if action == "addRow":
        """
        Expected payload:
        {
          "batch_id": "...",
          "course_id": "...",
          "enrollment_cap": 40,
          "remarks": "",
          "slot1": {"day": "Monday", "start_time": "730", "end_time": "900", "room_id": "ROOM123"},
          "slot2": {"day": "Thursday", "start_time": "1115", "end_time": "1245", "room_id": "ROOM456"},
          "faculty_id": "FAC001"   # (optional; first-assign)
        }
        """
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload.")
        batch_id = (payload.get("batch_id") or "").strip()
        course_id = (payload.get("course_id") or "").strip()
        if not (batch_id and course_id):
            raise HTTPException(status_code=400, detail="batch_id and course_id are required.")

        b = await db[COL_BATCHES].find_one({"batch_id": batch_id}, {"_id": 0, "batch_number": 1})
        batch_number = int(b["batch_number"]) if b and b.get("batch_number") else None

        section_code = await next_section_code_for_campus(sec_prefix or "", term_id)
        if not section_code:
            raise HTTPException(status_code=400, detail="Cannot derive section code for your campus.")

        sid = f"SEC{int(datetime.utcnow().timestamp()*1000)}"
        cap = int(payload.get("enrollment_cap") or 0)
        remarks = (payload.get("remarks") or "").strip()

        sec_doc = {
            "section_id": sid,
            "section_code": section_code,
            "course_id": course_id,
            "term_id": term_id,
            "enrollment_cap": cap if cap > 0 else None,
            "remarks": remarks,
            "batch_number": batch_number,
            "created_at": now(),
            "updated_at": now(),
        }
        await db[COL_SECTIONS].insert_one(sec_doc)

        # schedules (upsert two slots)
        for slot in ["slot1", "slot2"]:
            s = payload.get(slot) or {}
            day = normalize_day(s.get("day"))
            st = (s.get("start_time") or "").strip()
            et = (s.get("end_time") or "").strip()
            rid = (s.get("room_id") or "").strip()
            if day and st and et:
                sched_id = f"SCH-{sid}-{slot}"
                await db[COL_SCHEDS].insert_one({
                    "schedule_id": sched_id,
                    "section_id": sid,
                    "day": day,
                    "start_time": st,
                    "end_time": et,
                    "room_id": rid or None,
                    "created_at": now(),
                    "updated_at": now(),
                })

        # optional initial faculty assignment
        fid = (payload.get("faculty_id") or "").strip()
        if fid:
            load = await db[COL_FAC_LOADS].find_one({"term_id": term_id}, {"_id": 0, "load_id": 1})
            if load:
                await db[COL_FAC_ASSIGN].insert_one({
                    "assignment_id": f"FA-{sid}",
                    "load_id": load["load_id"],
                    "section_id": sid,
                    "faculty_id": fid,
                    "is_archived": False,
                    "created_at": now(),
                    "updated_at": now(),
                })

        return {"ok": True, "section_id": sid}

    if action == "editRow":
        """
        Expected payload:
        {
          "section_id": "...",
          "enrollment_cap": 35,           # optional
          "remarks": "..." ,              # optional
          "slot1": {"day": "Monday", "start_time": "730", "end_time": "900", "room_id": "ROOM123"}  # optional
          "slot2": {...}  # optional
          "faculty_id": "FAC001"         # optional (replace first)
        }
        """
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload.")
        section_id = (payload.get("section_id") or "").strip()
        if not section_id:
            raise HTTPException(status_code=400, detail="section_id is required.")

        updates: Dict[str, Any] = {}
        if "enrollment_cap" in payload:
            cap = int(payload.get("enrollment_cap") or 0)
            updates["enrollment_cap"] = cap if cap > 0 else None
        if "remarks" in payload:
            updates["remarks"] = (payload.get("remarks") or "").strip()
        if updates:
            updates["updated_at"] = now()
            await db[COL_SECTIONS].update_one({"section_id": section_id}, {"$set": updates})

        # upsert two slots (replace if a sched for same day+start+end exists; else create)
        for idx, slot in enumerate(["slot1", "slot2"], start=1):
            s = payload.get(slot)
            if not s:
                continue
            day = normalize_day(s.get("day"))
            st = (s.get("start_time") or "").strip()
            et = (s.get("end_time") or "").strip()
            rid = (s.get("room_id") or "").strip() or None
            if not (day and st and et):
                continue
            existing = await db[COL_SCHEDS].find_one(
                {"section_id": section_id, "day": day, "start_time": st, "end_time": et},
                {"_id": 0, "schedule_id": 1}
            )
            if existing:
                await db[COL_SCHEDS].update_one(
                    {"schedule_id": existing["schedule_id"]},
                    {"$set": {"room_id": rid, "updated_at": now()}}
                )
            else:
                sched_id = f"SCH-{section_id}-{idx}-{int(datetime.utcnow().timestamp()*1000)}"
                await db[COL_SCHEDS].insert_one({
                    "schedule_id": sched_id,
                    "section_id": section_id,
                    "day": day,
                    "start_time": st,
                    "end_time": et,
                    "room_id": rid,
                    "created_at": now(),
                    "updated_at": now(),
                })

        # replace first-assigned faculty if provided
        if "faculty_id" in payload:
            fid = (payload.get("faculty_id") or "").strip()
            load = await db[COL_FAC_LOADS].find_one({"term_id": term_id}, {"_id": 0, "load_id": 1})
            if load:
                # soft-archive all for this section, then add new one
                await db[COL_FAC_ASSIGN].update_many(
                    {"section_id": section_id, "load_id": load["load_id"]},
                    {"$set": {"is_archived": True, "updated_at": now()}}
                )
                if fid:
                    await db[COL_FAC_ASSIGN].insert_one({
                        "assignment_id": f"FA-{section_id}-{int(datetime.utcnow().timestamp()*1000)}",
                        "load_id": load["load_id"],
                        "section_id": section_id,
                        "faculty_id": fid,
                        "is_archived": False,
                        "created_at": now(),
                        "updated_at": now(),
                    })

        return {"ok": True, "section_id": section_id}

    if action == "deleteRow":
        """
        Expected payload: { "section_id": "..." }
        """
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload.")
        section_id = (payload.get("section_id") or "").strip()
        if not section_id:
            raise HTTPException(status_code=400, detail="section_id is required.")

        await db[COL_SCHEDS].delete_many({"section_id": section_id})
        await db[COL_FAC_ASSIGN].update_many({"section_id": section_id}, {"$set": {"is_archived": True}})
        await db[COL_SECTIONS].delete_one({"section_id": section_id})
        return {"ok": True, "deleted": 1}

    if action == "importCSV":
        """
        Accepts a CSV file with headings like:
        ID,Program Code,Course Code,Course Title,Section,Faculty,Day1,Begin1,End1,Room1,Day2,Begin2,End2,Room2,Capacity,Remarks
        NOTE: Course must already exist (by course_code). We derive course_id via lookup.
        """
        if not file:
            raise HTTPException(status_code=400, detail="file is required (multipart/form-data)")
        content = (await file.read()).decode("utf-8", errors="ignore")
        lines = [ln for ln in content.splitlines() if ln.strip() != ""]
        if not lines:
            raise HTTPException(status_code=400, detail="CSV is empty.")

        header = [h.strip().lower() for h in lines[0].replace("\ufeff", "").split(",")]
        idx = {name: i for i, name in enumerate(header)}

        def col(cols: List[str], key: str) -> str:
            i = idx.get(key.lower())
            return cols[i].strip() if (i is not None and i < len(cols)) else ""

        # cache course_code -> course_id
        code_to_id: Dict[str, str] = {}
        async for c in db[COL_COURSES].find({}, {"_id": 0, "course_id": 1, "course_code": 1}):
            code = c.get("course_code")
            code = code[0] if isinstance(code, list) and code else (code if isinstance(code, str) else "")
            if code:
                code_to_id[code.upper()] = c["course_id"]

        # cache batches
        batch_by_code: Dict[str, Dict[str, Any]] = {}
        async for b in db[COL_BATCHES].find({}, {"_id": 0, "batch_id": 1, "batch_number": 1, "batch_code": 1}):
            batch_by_code[(b.get("batch_code") or "").upper()] = b

        inserted = 0
        for raw in lines[1:]:
            cols = [x.strip() for x in raw.split(",")]

            batch_code = col(cols, "ID").upper()
            course_code = col(cols, "Course Code").upper()
            course_title = col(cols, "Course Title")
            section_in = col(cols, "Section").upper()  # if omitted, we'll auto-number
            faculty_name = col(cols, "Faculty")
            cap_s = col(cols, "Capacity")
            remarks = col(cols, "Remarks")

            # times/rooms (optional)
            d1, b1, e1, r1 = col(cols, "Day1"), col(cols, "Begin1"), col(cols, "End1"), col(cols, "Room1")
            d2, b2, e2, r2 = col(cols, "Day2"), col(cols, "Begin2"), col(cols, "End2"), col(cols, "Room2")

            course_id = code_to_id.get(course_code)
            if not course_id:
                # skip rows whose course doesn't exist; you can choose to create course if desired
                continue

            # batch
            batch = batch_by_code.get(batch_code)
            batch_number = int(batch["batch_number"]) if batch and batch.get("batch_number") else None

            # section code: prefer CSV given; else auto with campus prefix
            section_code = section_in or (await next_section_code_for_campus(sec_prefix or "", term_id))

            sid = f"SEC{int(datetime.utcnow().timestamp()*1000)}"
            cap = int(cap_s) if cap_s.isdigit() else None

            sec_doc = {
                "section_id": sid,
                "section_code": section_code,
                "course_id": course_id,
                "term_id": term_id,
                "enrollment_cap": cap,
                "remarks": remarks,
                "batch_number": batch_number,
                "created_at": now(),
                "updated_at": now(),
            }
            await db[COL_SECTIONS].insert_one(sec_doc)

            # schedule slots
            for slot_idx, (dd, bb, ee, rr) in enumerate([(d1, b1, e1, r1), (d2, b2, e2, r2)], start=1):
                ddn = normalize_day(dd)
                if ddn and bb and ee:
                    await db[COL_SCHEDS].insert_one({
                        "schedule_id": f"SCH-{sid}-{slot_idx}",
                        "section_id": sid,
                        "day": ddn,
                        "start_time": bb,
                        "end_time": ee,
                        "room_id": rr or None,
                        "created_at": now(),
                        "updated_at": now(),
                    })

            # NOTE: Faculty linking by name → faculty_id requires a map; skip unless you have a canonical mapping.
            inserted += 1

        return {"ok": True, "inserted": inserted}

    if action == "forward":
        """
        Expected payload:
        { "to": "user@example.com", "subject": "...", "message": "...", "attachment_html": "<div>...</div>" }
        We store to outbox with campus+term. (Email sending pipeline can read outbox.)
        """
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload.")
        to = (payload.get("to") or "").strip()
        subject = (payload.get("subject") or "").strip()
        message = (payload.get("message") or "").strip()
        attachment_html = (payload.get("attachment_html") or "").strip()
        if not to:
            raise HTTPException(status_code=400, detail="'to' is required.")

        oid = f"OUT-{int(datetime.utcnow().timestamp()*1000)}"
        doc = {
            "outbox_id": oid,
            "to": to,
            "subject": subject,
            "message": message,
            "attachment_html": attachment_html,
            "term_id": term_id,
            "campus_id": campus_id,
            "created_at": now(),
            "status": "queued"
        }
        await db[COL_OUTBOX].insert_one(doc)
        return {"ok": True, "queued": True, "outbox_id": oid}

    raise HTTPException(status_code=400, detail="Invalid action.")
