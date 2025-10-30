from datetime import datetime
from math import ceil
import re
from typing import Any, Dict, List, Optional, Tuple, Literal

from fastapi import APIRouter, HTTPException, Query, Body
from pymongo.errors import DuplicateKeyError
from ..main import db

router = APIRouter(prefix="/apo", tags=["apo"])

# ------------ collections ------------
COL_TERMS = "terms"
COL_CURRICULUM = "curriculum"
COL_COURSES = "courses"
COL_DEPARTMENTS = "departments"
COL_PROGRAMS = "programs"
COL_BATCHES = "batches"
COL_SECTIONS = "sections"
COL_SCHEDS = "section_schedules"
COL_ROOMS = "rooms"
COL_USERS = "users"
COL_FAC_PROFILES = "faculty_profiles"
COL_FAC_LOADS = "faculty_loads"
COL_FAC_ASSIGN = "faculty_assignments"
COL_PREEN = "preenlistment_count"
COL_USER_ROLES = "user_roles"
COL_ROLE_ASSIGN = "role_assignments"
COL_OUTBOX = "outbox"
COL_CAMPUSES = "campuses"

# ------------ utils ------------
def now() -> datetime:
    return datetime.utcnow()

def _norm_code(code: Optional[str]) -> str:
    s = (code or "").strip().upper()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"^ID\s*(\d+)$", r"ID \1", s)
    return s

async def current_term() -> Optional[Dict[str, Any]]:
    return await db[COL_TERMS].find_one({"is_current": True}, {"_id": 0})

def term_label(t: Optional[Dict[str, Any]]) -> str:
    if not t:
        return ""
    n = t.get("term_number")
    ays = t.get("acad_year_start")
    aye = (ays + 1) if isinstance(ays, int) else None
    return f"Term {n} · AY {ays}-{aye}" if (n and ays and aye) else (t.get("term_id") or "")

async def apo_scope(user_id: str) -> Tuple[Optional[str], Optional[str]]:
    role = await db[COL_USER_ROLES].find_one(
        {"role_type": {"$regex": "^APO$", "$options": "i"}}, {"_id": 0, "role_id": 1}
    )
    if not role:
        return (None, None)
    ra = await db[COL_ROLE_ASSIGN].find_one(
        {"user_id": user_id, "role_id": role["role_id"]}, {"_id": 0, "scope": 1}
    )
    if not ra:
        return (None, None)
    campus_id, college_id = None, None
    scope = ra.get("scope") or []
    if isinstance(scope, dict):
        scope = [scope]
    for s in scope:
        if isinstance(s, dict) and s.get("type") == "campus":
            campus_id = s.get("id")
        if isinstance(s, dict) and s.get("type") == "college":
            college_id = s.get("id")
    return (campus_id, college_id)

async def campus_meta(campus_id: Optional[str]) -> Dict[str, str]:
    if not campus_id:
        return {"campus_id": "", "campus_name": ""}
    c = await db[COL_CAMPUSES].find_one(
        {"campus_id": campus_id}, {"_id": 0, "campus_id": 1, "campus_name": 1}
    )
    return c or {"campus_id": campus_id, "campus_name": ""}

def campus_section_prefix(campus_name: str) -> Optional[str]:
    n = (campus_name or "").lower()
    if "laguna" in n or "biñan" in n or "binan" in n or "canlubang" in n:
        return "X"
    if "manila" in n or "taft" in n:
        return "S"
    return None

DAY_NAME = {
    "M": "Monday","MON": "Monday","MONDAY": "Monday",
    "T": "Tuesday","TU": "Tuesday","TUE": "Tuesday",
    "W": "Wednesday","WED": "Wednesday",
    "TH": "Thursday","THU": "Thursday","H": "Thursday","R": "Thursday",
    "F": "Friday","FRI": "Friday",
    "S": "Saturday","SAT": "Saturday",
}
DOW = {"Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"}

def normalize_day(v: Any) -> str:
    if not v:
        return ""
    s = str(v).strip()
    if s in DOW:
        return s
    return DAY_NAME.get(s.upper(), s.title() if s.title() in DOW else s)

def caps_name(u: Dict[str, Any]) -> str:
    first, last = (u.get("first_name") or "").strip(), (u.get("last_name") or "").strip()
    mid = (u.get("middle_name") or "").strip()
    return f"{last}, {first} {mid}".strip().upper() if mid else f"{last}, {first}".strip().upper()

async def map_courses(course_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    if not course_ids:
        return out
    cur = db[COL_COURSES].find(
        {"course_id": {"$in": course_ids}},
        {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1,
         "department_id": 1, "program_level": 1}
    )
    async for c in cur:
        code = c.get("course_code")
        if isinstance(code, list):
            code = code[0] if code else ""
        out[c["course_id"]] = {
            "course_code": code if isinstance(code, str) else "",
            "course_title": c.get("course_title", ""),
            "department_id": c.get("department_id", ""),
            "program_level": c.get("program_level", ""),
        }
    return out

async def map_departments(dep_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    if not dep_ids:
        return out
    cur = db[COL_DEPARTMENTS].find(
        {"department_id": {"$in": dep_ids}},
        {"_id": 0, "department_id": 1, "department_name": 1, "dept_name": 1}
    )
    async for d in cur:
        out[d["department_id"]] = { "department_name": d.get("department_name") or d.get("dept_name") or "" }
    return out

async def map_batches() -> Tuple[Dict[int, Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    by_number: Dict[int, Dict[str, Any]] = {}
    by_id: Dict[str, Dict[str, Any]] = {}
    cur = db[COL_BATCHES].find({}, {"_id": 0, "batch_id": 1, "batch_number": 1, "batch_code": 1})
    async for b in cur:
        n = int(b.get("batch_number") or 0)
        by_number[n] = b
        by_id[b["batch_id"]] = b
    return by_number, by_id

async def map_programs(p_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    if not p_ids:
        return out
    cur = db[COL_PROGRAMS].find(
        {"program_id": {"$in": p_ids}},
        {"_id": 0, "program_id": 1, "program_code": 1}
    )
    async for p in cur:
        out[p["program_id"]] = {"program_code": p.get("program_code", "")}
    return out

# ---------- demand helpers ----------
async def preen_total_for_course(term_id: str, campus_id: Optional[str], course_id: str) -> int:
    cond: Dict[str, Any] = {"course_id": course_id, "term_id": term_id, "is_archived": {"$ne": True}}
    if campus_id and await db[COL_PREEN].count_documents({**cond, "campus_id": campus_id}) > 0:
        cond["campus_id"] = campus_id
    total = 0
    async for r in db[COL_PREEN].find(cond, {"_id": 0, "preenlistment_count": 1, "count": 1}):
        total += int(r.get("preenlistment_count") or r.get("count") or 0)
    return total

# ---------- section numbering / safety ----------
async def _max_section_number(prefix: str, term_id: str, course_id: str) -> int:
    """Highest numeric part for existing codes with the given prefix in this term+course."""
    if not prefix:
        return 10
    pat = {"$regex": f"^{prefix}\\d+$", "$options": "i"}
    nums: List[int] = []
    cur = db[COL_SECTIONS].find(
        {"term_id": term_id, "course_id": course_id, "section_code": pat},
        {"_id": 0, "section_code": 1},
    )
    async for s in cur:
        code = (s.get("section_code") or "").upper()
        digits = "".join(ch for ch in code if ch.isdigit())
        if digits.isdigit():
            nums.append(int(digits))
    return max(nums) if nums else 10

async def next_section_code(prefix: str, term_id: str, course_id: str) -> str:
    start = await _max_section_number(prefix, term_id, course_id) + 1
    return f"{prefix}{start}" if prefix else ""

async def safe_insert_section(doc: Dict[str, Any]) -> Optional[str]:
    """Insert once; if duplicate (race), bump code and retry a few times. No new index creation."""
    retries = 6
    for _ in range(retries):
        try:
            await db[COL_SECTIONS].insert_one(doc)
            return doc["section_id"]
        except DuplicateKeyError:
            prefix = re.match(r"^[A-Za-z]+", doc["section_code"]).group(0) if doc.get("section_code") else ""
            maxn = await _max_section_number(prefix, doc["term_id"], doc["course_id"])
            doc["section_code"] = f"{prefix}{maxn+1}"
            doc["section_id"] = f"SEC{int(datetime.utcnow().timestamp()*1000)}"
    return None

async def ensure_sections_from_demand(
    *, term_id: str, campus_id: str, campus_prefix: str, course_id: str,
    base_per_program: int, capacity: int = 20
) -> None:
    """Ensure enough sections exist: at least 1 per distinct program, then top-up to ceil(demand/20)."""
    q: Dict[str, Any] = {"term_id": term_id, "course_id": course_id}
    if campus_prefix:
        q["section_code"] = {"$regex": f"^{campus_prefix}", "$options": "i"}
    existing = await db[COL_SECTIONS].count_documents(q)

    # Pass A — one per distinct program
    if existing < base_per_program:
        to_make = base_per_program - existing
        for _ in range(to_make):
            code = await next_section_code(campus_prefix, term_id, course_id)
            doc = {
                "section_id": f"SEC{int(datetime.utcnow().timestamp()*1000)}",
                "section_code": code,
                "course_id": course_id,
                "term_id": term_id,
                "enrollment_cap": capacity,
                "remarks": "",
                "created_at": now(),
                "updated_at": now(),
            }
            await safe_insert_section(doc)
        existing += to_make

    # Pass B — top-up by demand
    total = await preen_total_for_course(term_id, campus_id, course_id)
    needed = max(base_per_program, ceil((total or 0) / (capacity or 20))) or 1
    if existing < needed:
        for _ in range(needed - existing):
            code = await next_section_code(campus_prefix, term_id, course_id)
            doc = {
                "section_id": f"SEC{int(datetime.utcnow().timestamp()*1000)}",
                "section_code": code,
                "course_id": course_id,
                "term_id": term_id,
                "enrollment_cap": capacity,
                "remarks": "",
                "created_at": now(),
                "updated_at": now(),
            }
            await safe_insert_section(doc)

# ---------- faculty & schedule helpers ----------
async def first_faculty_name_for_section(term_id: str, section_id: str) -> Tuple[str, Optional[str]]:
    load = await db[COL_FAC_LOADS].find_one({"term_id": term_id}, {"_id": 0, "load_id": 1})
    if not load:
        return ("UNASSIGNED", None)
    fa = await db[COL_FAC_ASSIGN].find_one(
        {"section_id": section_id, "load_id": load["load_id"], "is_archived": {"$ne": True}},
        {"_id": 0, "faculty_id": 1},
    )
    if not fa:
        return ("UNASSIGNED", None)
    prof = await db[COL_FAC_PROFILES].find_one({"faculty_id": fa["faculty_id"]}, {"_id": 0, "user_id": 1})
    if not prof:
        return ("UNASSIGNED", fa["faculty_id"])
    user = await db[COL_USERS].find_one(
        {"user_id": prof["user_id"]}, {"_id": 0, "first_name": 1, "middle_name": 1, "last_name": 1}
    )
    return (caps_name(user) if user else "UNASSIGNED", fa["faculty_id"])

def pick_two_sched(scheds: List[Dict[str, Any]]):
    def key(s):
        d = normalize_day(s.get("day"))
        si = int(str(s.get("start_time") or "0"))
        return (d, si)
    return sorted(scheds, key=key)[:2]

# ---------- NEW: deterministic seating (no DB writes) ----------
def _sort_sections_by_number(sections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    def num(s):
        code = (s.get("section_code") or "").upper()
        d = "".join(ch for ch in code if ch.isdigit())
        try:
            return int(d)
        except Exception:
            return 0
    return sorted(sections, key=num)

def _assign_blocks_to_sections(block_keys: List[Tuple[str, str, str]],
                               sections: List[Dict[str, Any]]) -> Dict[Tuple[str, str], Dict[str, Any]]:
    """
    block_keys: list of (batch_id, program_id, program_no_label) in stable order.
    returns map[(batch_id, program_id)] -> section_doc
    """
    seating: Dict[Tuple[str, str], Dict[str, Any]] = {}
    secs = _sort_sections_by_number(sections)
    for i, (bid, pid, _label) in enumerate(block_keys):
        if not secs:
            break
        seating[(bid, pid)] = secs[i % len(secs)]  # one block per section; wraps if needed
    return seating

# ---------- GET ----------
@router.get("/courseofferings")
async def get_course_offerings(
    userId: str = Query(..., min_length=3),
    level: Optional[str] = Query(None),
    department_id: Optional[str] = Query(None),
    batch_id: Optional[str] = Query(None),
    program_id: Optional[str] = Query(None),
):
    t = await current_term()
    term_id = (t or {}).get("term_id")
    if not term_id:
        return {
            "campus": {"campus_id": "", "campus_name": ""},
            "term_id": "", "term_label": "",
            "filters": {"levels": [], "departments": [], "ids": [], "programs": []},
            "rows": [], "course_options_by_group": {}
        }

    campus_id, _ = await apo_scope(userId)
    if not campus_id:
        raise HTTPException(status_code=400, detail="Unable to resolve APO campus from role_assignments.")
    campus = await campus_meta(campus_id)
    prefix = campus_section_prefix(campus.get("campus_name", "")) or ""

    # curricula for the term (for creation + seating)
    all_curr = [x async for x in db[COL_CURRICULUM].find(
        {"term_id": term_id},
        {"_id": 0, "curriculum_id": 1, "program_id": 1, "batch_id": 1, "term_id": 1, "course_list": 1}
    )]

    # maps
    batch_by_number, batch_by_id = await map_batches()
    prog_ids_all = list({c["program_id"] for c in all_curr if c.get("program_id")})
    prog_map = await map_programs(prog_ids_all)
    all_course_ids_all = sorted(list({cid for c in all_curr for cid in (c.get("course_list") or [])}))
    c_map_all = await map_courses(all_course_ids_all)
    dep_ids_all = sorted(list({c_map_all[cid]["department_id"] for cid in c_map_all if c_map_all[cid].get("department_id")}))
    dep_map = await map_departments(dep_ids_all)

    def level_ok(cid: str) -> bool:
        return (not level) or (c_map_all.get(cid, {}).get("program_level") == level)
    def dept_ok(cid: str) -> bool:
        return (not department_id) or (c_map_all.get(cid, {}).get("department_id") == department_id)

    # distinct program set per course (term-wide) — to ensure enough sections exist
    course_to_programs: Dict[str, set] = {}
    for cur in all_curr:
        pid = cur.get("program_id")
        for cid in (cur.get("course_list") or []):
            if not pid:
                continue
            course_to_programs.setdefault(cid, set()).add(pid)

    # ensure sections exist per course BEFORE fetch
    for cid, prog_set in course_to_programs.items():
        base = max(1, len(prog_set))
        await ensure_sections_from_demand(
            term_id=term_id, campus_id=campus_id, campus_prefix=prefix,
            course_id=cid, base_per_program=base, capacity=20
        )

    # view filter for curricula
    view_q: Dict[str, Any] = {"term_id": term_id}
    if batch_id: view_q["batch_id"] = batch_id
    if program_id: view_q["program_id"] = program_id
    curricula = [x async for x in db[COL_CURRICULUM].find(
        view_q,
        {"_id": 0, "curriculum_id": 1, "program_id": 1, "batch_id": 1, "term_id": 1, "course_list": 1}
    )]

    # courses in view
    view_course_ids = sorted(list({cid for c in curricula for cid in (c.get("course_list") or [])}))
    c_map = {cid: c_map_all[cid] for cid in view_course_ids if cid in c_map_all}

    # filters payload
    levels = sorted(list({c_map_all[cid]["program_level"] for cid in c_map_all if c_map_all[cid].get("program_level")}))
    dep_opts = [{"department_id": d, "department_name": dep_map.get(d, {}).get("department_name", "")} for d in dep_ids_all]

    # ID options (dedup)
    id_opts_unsorted: List[Dict[str, Any]] = []
    seen_batch_ids = set()
    for c in curricula:
        b = batch_by_id.get(c.get("batch_id") or "")
        if not b: continue
        bid = b["batch_id"]
        if bid in seen_batch_ids: continue
        seen_batch_ids.add(bid)
        id_opts_unsorted.append({
            "batch_id": bid,
            "batch_code": _norm_code(b.get("batch_code")),
            "batch_number": int(b.get("batch_number") or 0),
        })
    id_opts_unsorted.sort(key=lambda x: (-x["batch_number"], x["batch_code"]))
    id_opts = [{"batch_id": x["batch_id"], "batch_code": x["batch_code"]} for x in id_opts_unsorted]

    # Programs in view (dedup)
    prog_opts, seen_prog = [], set()
    for c in curricula:
        pid = c.get("program_id")
        if not pid or pid in seen_prog: continue
        seen_prog.add(pid)
        prog_opts.append({"program_id": pid, "program_code": (prog_map.get(pid, {}) or {}).get("program_code", "")})

    allowed_course_ids = {cid for cid in view_course_ids if level_ok(cid) and dept_ok(cid)}

    # course options per (batch, program) combo
    options_by_group: Dict[str, List[Dict[str, str]]] = {}
    for cur in curricula:
        key = f'{cur.get("batch_id","")}|{cur.get("program_id","")}'
        opts: List[Dict[str, str]] = []
        for cid in (cur.get("course_list") or []):
            if cid not in allowed_course_ids: continue
            cm = c_map.get(cid, {})
            if not cm: continue
            opts.append({"course_id": cid, "course_code": cm.get("course_code", ""), "course_title": cm.get("course_title", "")})
        # dedup + sort
        seen, uniq = set(), []
        for o in opts:
            if o["course_id"] in seen: continue
            seen.add(o["course_id"])
            uniq.append(o)
        options_by_group[key] = sorted(uniq, key=lambda x: x["course_code"])

    # Program No. (display-only)
    prog_no_cache: Dict[Tuple[str, str], str] = {}
    per_batch_prog_seq: Dict[Tuple[str, str], int] = {}
    def program_no_for(batch_id: Optional[str], program_id: Optional[str]) -> str:
        key = (batch_id or "", program_id or "")
        if key in prog_no_cache:
            return prog_no_cache[key]
        prog_code = (prog_map.get(program_id or "", {}) or {}).get("program_code", "") or "PROG"
        seq_key = (batch_id or "", prog_code)
        per_batch_prog_seq[seq_key] = per_batch_prog_seq.get(seq_key, 0) + 1
        label = f"{prog_code}-{per_batch_prog_seq[seq_key]}"
        prog_no_cache[key] = label
        return label

    def _bn(bid: Optional[str]) -> int:
        b = batch_by_id.get(bid or "", {})
        try:
            return int(b.get("batch_number") or 0)
        except Exception:
            return 0
    def _pc(pid: Optional[str]) -> str:
        return (prog_map.get(pid or "", {}) or {}).get("program_code", "") or ""

    # STABLE order of blocks for seating
    curricula_sorted = sorted(curricula, key=lambda x: (-_bn(x.get("batch_id")), _pc(x.get("program_id"))))
    block_keys_by_course: Dict[str, List[Tuple[str, str, str]]] = {}
    for cur in curricula_sorted:
        label = program_no_for(cur.get("batch_id"), cur.get("program_id"))
        for cid in (cur.get("course_list") or []):
            if cid in allowed_course_ids:
                block_keys_by_course.setdefault(cid, []).append((cur.get("batch_id",""), cur.get("program_id",""), label))

    # build rows (one row per program-course with its assigned section)
    rows: List[Dict[str, Any]] = []

    # pre-fetch all campus sections for courses in view
    campus_sec_by_course: Dict[str, List[Dict[str, Any]]] = {}
    for cid in allowed_course_ids:
        sec_q: Dict[str, Any] = {"term_id": term_id, "course_id": cid}
        if prefix:
            sec_q["section_code"] = {"$regex": f"^{prefix}", "$options": "i"}
        campus_sec_by_course[cid] = [s async for s in db[COL_SECTIONS].find(
            sec_q,
            {"_id": 0, "section_id": 1, "section_code": 1, "enrollment_cap": 1, "remarks": 1}
        )]

    # assemble per program-course
    for cur in curricula_sorted:
        binfo = batch_by_id.get(cur.get("batch_id") or "", {})
        batch_num = int(binfo.get("batch_number") or 0)
        prog_no_label = program_no_for(cur.get("batch_id"), cur.get("program_id"))

        for course_id in (cur.get("course_list") or []):
            if course_id not in allowed_course_ids: 
                continue

            cinfo = c_map.get(course_id, {})
            dep_name = dep_map.get(cinfo.get("department_id", ""), {}).get("department_name", "")

            # find the section assigned to this (batch, program) for this course
            blocks_for_course = block_keys_by_course.get(course_id, [])
            assigned = _assign_blocks_to_sections(blocks_for_course, campus_sec_by_course.get(course_id, []))
            sec_for_block = assigned.get((cur.get("batch_id",""), cur.get("program_id","")))

            # preenlistment totals for sizing
            total_intent = await preen_total_for_course(term_id, campus_id, course_id)

            if not sec_for_block:
                # No section yet: show suggestion row with blank section (UI may add row)
                rows.append({
                    "program_no": prog_no_label,
                    "batch": {"batch_id": binfo.get("batch_id", ""), "batch_code": _norm_code(binfo.get("batch_code")), "batch_number": batch_num or None},
                    "program": {"program_id": cur.get("program_id", ""), "program_code": (prog_map.get(cur.get("program_id", ""), {}) or {}).get("program_code", "")},
                    "course": {"course_id": course_id, "course_code": cinfo.get("course_code",""), "course_title": cinfo.get("course_title",""),
                               "program_level": cinfo.get("program_level",""), "department_id": cinfo.get("department_id",""), "department_name": dep_name},
                    "section": {"section_id": "", "section_code": "", "enrollment_cap": None, "remarks": ""},
                    "faculty": {"faculty_id": None, "user_id": None, "faculty_name": "UNASSIGNED"},
                    "slot1": None, "slot2": None,
                    "links": {"curriculum_id": cur.get("curriculum_id"), "term_id": term_id, "course_id": course_id,
                              "batch_id": binfo.get("batch_id", ""), "program_id": cur.get("program_id", "")},
                    "sizing": {"preenlistment_total": total_intent or 0, "suggested_sections": ceil((total_intent or 0)/20) if total_intent else None},
                })
                continue

            sid = sec_for_block["section_id"]
            # schedules of that section
            scheds = [x async for x in db[COL_SCHEDS].find(
                {"section_id": sid},
                {"_id": 0, "schedule_id": 1, "section_id": 1, "day": 1, "start_time": 1, "end_time": 1, "room_id": 1}
            )]
            picked = pick_two_sched(scheds)
            # rooms
            rids = list({sc.get("room_id") for sc in scheds if sc.get("room_id")})
            rmap: Dict[str, Dict[str, Any]] = {}
            if rids:
                async for r in db[COL_ROOMS].find({"room_id": {"$in": rids}}, {"_id": 0, "room_id": 1, "room_number": 1}):
                    rmap[r["room_id"]] = r
            def slot_payload(x: Optional[Dict[str, Any]]):
                if not x:
                    return None
                rid = x.get("room_id")
                return {
                    "schedule_id": x.get("schedule_id", ""),
                    "day": normalize_day(x.get("day")),
                    "start_time": x.get("start_time", ""),
                    "end_time": x.get("end_time", ""),
                    "room_id": rid or "",
                    "room_number": (rmap.get(rid) or {}).get("room_number", "") if rid else "",
                }
            faculty_name, faculty_id = await first_faculty_name_for_section(term_id, sid)

            rows.append({
                "program_no": prog_no_label,
                "batch": {"batch_id": binfo.get("batch_id", ""), "batch_code": _norm_code(binfo.get("batch_code")), "batch_number": batch_num or None},
                "program": {"program_id": cur.get("program_id", ""), "program_code": (prog_map.get(cur.get("program_id", ""), {}) or {}).get("program_code", "")},
                "course": {"course_id": course_id, "course_code": cinfo.get("course_code",""), "course_title": cinfo.get("course_title",""),
                           "program_level": cinfo.get("program_level",""), "department_id": cinfo.get("department_id",""), "department_name": dep_name},
                "section": {"section_id": sid, "section_code": sec_for_block.get("section_code",""),
                            "enrollment_cap": sec_for_block.get("enrollment_cap"), "remarks": sec_for_block.get("remarks","")},
                "faculty": {"faculty_id": faculty_id, "user_id": None, "faculty_name": faculty_name},
                "slot1": slot_payload(picked[0]) if len(picked) >= 1 else None,
                "slot2": slot_payload(picked[1]) if len(picked) >= 2 else None,
                "links": {"curriculum_id": cur.get("curriculum_id"), "term_id": term_id, "course_id": course_id,
                          "batch_id": binfo.get("batch_id", ""), "program_id": cur.get("program_id", ""), "section_id": sid},
                "sizing": {"preenlistment_total": total_intent or 0, "suggested_sections": ceil((total_intent or 0)/20) if total_intent else None},
            })

    return {
        "campus": campus, "term_id": term_id, "term_label": term_label(t),
        "filters": {"levels": levels, "departments": dep_opts, "ids": id_opts, "programs": prog_opts},
        "rows": rows, "course_options_by_group": options_by_group,
    }

# ---------- POST ----------
@router.post("/courseofferings")
async def post_course_offerings(
    userId: str = Query(..., min_length=3),
    action: Literal["addRow", "editRow", "deleteRow", "forward"] = Query(...),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    t = await current_term()
    term_id = (t or {}).get("term_id")
    if not term_id:
        raise HTTPException(status_code=400, detail="No active term.")

    campus_id, _ = await apo_scope(userId)
    if not campus_id:
        raise HTTPException(status_code=400, detail="Unable to resolve APO campus from role_assignments.")
    campus = await campus_meta(campus_id)
    prefix = campus_section_prefix(campus.get("campus_name", "")) or ""

    if action == "addRow":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload.")
        batch_id = (payload.get("batch_id") or "").strip()
        course_id = (payload.get("course_id") or "").strip()
        if not (batch_id and course_id):
            raise HTTPException(status_code=400, detail="batch_id and course_id are required.")

        b = await db[COL_BATCHES].find_one({"batch_id": batch_id}, {"_id": 0, "batch_number": 1})
        batch_number = int(b["batch_number"]) if (b and b.get("batch_number")) else None

        section_code = await next_section_code(prefix, term_id, course_id)
        sid = f"SEC{int(datetime.utcnow().timestamp()*1000)}"
        cap = payload.get("enrollment_cap")
        cap = int(cap) if cap not in (None, "") else 20
        remarks = (payload.get("remarks") or "").strip()

        doc = {
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
        inserted = await safe_insert_section(doc)
        if not inserted:
            raise HTTPException(status_code=409, detail="Could not allocate a unique section code. Try again.")

        # optional room placeholders
        for idx, key in enumerate(["slot1", "slot2"], start=1):
            s = (payload.get(key) or {})
            rid = (s.get("room_id") or "").strip() or None
            if rid:
                await db[COL_SCHEDS].insert_one({
                    "schedule_id": f"SCH-{sid}-{idx}",
                    "section_id": sid, "day": "", "start_time": "", "end_time": "",
                    "room_id": rid, "created_at": now(), "updated_at": now(),
                })
        return {"ok": True, "section_id": sid}

    if action == "editRow":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload.")
        section_id = (payload.get("section_id") or "").strip()
        if not section_id:
            raise HTTPException(status_code=400, detail="section_id is required.")

        sec_updates: Dict[str, Any] = {}
        if "section_code" in payload:
            sec_updates["section_code"] = (payload.get("section_code") or "").strip()
        if "enrollment_cap" in payload:
            cap = payload.get("enrollment_cap")
            sec_updates["enrollment_cap"] = int(cap) if cap not in (None, "") else None
        if "remarks" in payload:
            sec_updates["remarks"] = (payload.get("remarks") or "").strip()
        if sec_updates:
            sec_updates["updated_at"] = now()
            await db[COL_SECTIONS].update_one({"section_id": section_id}, {"$set": sec_updates})

        for idx, key in enumerate(["slot1", "slot2"], start=1):
            s = payload.get(key)
            if s is None:
                continue
            rid = (s.get("room_id") or "").strip() or None
            existing = await db[COL_SCHEDS].find_one(
                {"section_id": section_id, "schedule_id": {"$regex": f"^SCH-{section_id}-{idx}"}}
            )
            if existing:
                await db[COL_SCHEDS].update_one({"schedule_id": existing["schedule_id"]},
                                                {"$set": {"room_id": rid, "updated_at": now()}})
            else:
                await db[COL_SCHEDS].insert_one({
                    "schedule_id": f"SCH-{section_id}-{idx}-{int(datetime.utcnow().timestamp()*1000)}",
                    "section_id": section_id, "day": "", "start_time": "", "end_time": "",
                    "room_id": rid, "created_at": now(), "updated_at": now(),
                })
        return {"ok": True, "section_id": section_id}

    if action == "deleteRow":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload.")
        section_id = (payload.get("section_id") or "").strip()
        if not section_id:
            raise HTTPException(status_code=400, detail="section_id is required.")
        await db[COL_SCHEDS].delete_many({"section_id": section_id})
        await db[COL_FAC_ASSIGN].update_many({"section_id": section_id}, {"$set": {"is_archived": True, "updated_at": now()}})
        await db[COL_SECTIONS].delete_one({"section_id": section_id})
        return {"ok": True, "deleted": 1}

    if action == "forward":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload.")
        to = (payload.get("to") or "").strip()
        if not to:
            raise HTTPException(status_code=400, detail="'to' is required.")
        oid = f"OUT-{int(datetime.utcnow().timestamp()*1000)}"
        await db[COL_OUTBOX].insert_one({
            "outbox_id": oid, "to": to,
            "subject": (payload.get("subject") or "").strip(),
            "message": (payload.get("message") or "").strip(),
            "attachment_html": (payload.get("attachment_html") or "").strip(),
            "term_id": term_id, "campus_id": campus_id,
            "created_at": now(), "status": "queued",
        })
        return {"ok": True, "queued": True, "outbox_id": oid}

    raise HTTPException(status_code=400, detail="Invalid action.")
