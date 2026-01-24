from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
import io

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import StreamingResponse
from pymongo import ASCENDING

from ..main import db

# --- reportlab (required for PDF) ---
try:
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.pagesizes import A4 as RL_A4
    from reportlab.lib import colors
except ModuleNotFoundError:
    rl_canvas = None
    RL_A4 = None
    colors = None

router = APIRouter(prefix="/om", tags=["om"])

# ---------------- collections ----------------
COL_SPECIAL = "special_class"
COL_TERMS = "terms"
COL_USERS = "users"
COL_PROGRAMS = "programs"
COL_DEPARTMENTS = "departments"
COL_COURSES = "courses"

COL_SECTIONS = "sections"
COL_SECTION_SCHEDULES = "section_schedules"
COL_FAC_ASSIGN = "faculty_assignments"
COL_FAC_PROFILES = "faculty_profiles"
COL_FAC_LOADS = "faculty_loads"  
COL_PREEN_COUNT = "preenlistment_count"


OM_ALLOWED_STATUSES = ["Forwarded To Department", "Approved", "Rejected"]


# ---------------- indexes (safe) ----------------
try:
    db[COL_SPECIAL].create_index([("term_id", ASCENDING)])
    db[COL_SPECIAL].create_index([("course_id", ASCENDING)])
    db[COL_SPECIAL].create_index([("department_id", ASCENDING)])
    db[COL_SPECIAL].create_index([("status", ASCENDING)])
    db[COL_SPECIAL].create_index([("submitted_at", ASCENDING)])
    db[COL_SPECIAL].create_index([("special_id", ASCENDING)], unique=True)
except Exception:
    pass

# ---------------- constants/helpers ----------------
DAY_ORDER = {"M": 1, "T": 2, "W": 3, "H": 4, "F": 5, "S": 6, "U": 7}
ALLOWED_DAYS = {"M", "T", "W", "H", "F", "S"}

REASON_LINES = [
    "Graduating at the end of this Term and course is not offered",
    "Graduating at the end of this Term and course offered is\nconflict with other enrolled courses",
    "The course is indicated in the program flowchart as a regular\noffering for the term but is not offered",
    "Others (please specify)",
]


def _normalize_day(d: Any) -> str:
    if d is None:
        return ""
    s = str(d).strip().upper()
    if not s:
        return ""
    if s in ALLOWED_DAYS:
        return s
    if s in {"TH", "THU", "THUR", "THURS", "THURSDAY"}:
        return "H"
    if s in {"MO", "MON", "MONDAY"}:
        return "M"
    if s in {"TU", "TUE", "TUES", "TUESDAY"}:
        return "T"
    if s in {"WE", "WED", "WEDNESDAY"}:
        return "W"
    if s in {"FR", "FRI", "FRIDAY"}:
        return "F"
    if s in {"SA", "SAT", "SATURDAY"}:
        return "S"
    if "MON" in s:
        return "M"
    if "TUE" in s:
        return "T"
    if "WED" in s:
        return "W"
    if "THU" in s or "THR" in s:
        return "H"
    if "FRI" in s:
        return "F"
    if "SAT" in s:
        return "S"
    return ""


def _to_hhmm(t: Any) -> str:
    if t is None:
        return ""
    s = str(t).strip()
    if not s:
        return ""
    s = s.replace(":", "").replace(" ", "")
    if not s.isdigit():
        return ""
    if len(s) == 3:
        s = "0" + s
    if len(s) != 4:
        return ""
    return s


def _is_valid_hhmm(hhmm: str) -> bool:
    if not hhmm or len(hhmm) != 4 or (not hhmm.isdigit()):
        return False
    hh = int(hhmm[:2])
    mm = int(hhmm[2:])
    return 0 <= hh <= 23 and 0 <= mm <= 59


def _mins(hhmm: str) -> int:
    return int(hhmm[:2]) * 60 + int(hhmm[2:])


def _validate_day_fields(payload: Dict[str, Any]) -> Dict[str, str]:
    day1 = _normalize_day(payload.get("day1"))
    begin1 = _to_hhmm(payload.get("begin1"))
    end1 = _to_hhmm(payload.get("end1"))

    day2 = _normalize_day(payload.get("day2"))
    begin2 = _to_hhmm(payload.get("begin2"))
    end2 = _to_hhmm(payload.get("end2"))

    if any([day1, begin1, end1]):
        if day1 not in ALLOWED_DAYS:
            raise HTTPException(status_code=400, detail="day1 must be one of M,T,W,H,F,S.")
        if not (_is_valid_hhmm(begin1) and _is_valid_hhmm(end1)):
            raise HTTPException(status_code=400, detail="begin1/end1 must be valid HHMM.")
        if _mins(end1) <= _mins(begin1):
            raise HTTPException(status_code=400, detail="end1 must be greater than begin1.")

    if any([day2, begin2, end2]):
        if day2 not in ALLOWED_DAYS:
            raise HTTPException(status_code=400, detail="day2 must be one of M,T,W,H,F,S.")
        if not (_is_valid_hhmm(begin2) and _is_valid_hhmm(end2)):
            raise HTTPException(status_code=400, detail="begin2/end2 must be valid HHMM.")
        if _mins(end2) <= _mins(begin2):
            raise HTTPException(status_code=400, detail="end2 must be greater than begin2.")

    return {
        "day1": day1,
        "begin1": begin1,
        "end1": end1,
        "day2": day2,
        "begin2": begin2,
        "end2": end2,
    }


def _upper_name(fn: str, ln: str) -> str:
    fn = (fn or "").strip()
    ln = (ln or "").strip()
    full = f"{ln}, {fn}".strip().strip(",")
    return full.upper() if full else "UNASSIGNED"


async def _active_term() -> Dict[str, Any]:
    pre = await db[COL_PREEN_COUNT].find_one(
        {"is_archived": {"$ne": True}},
        {"_id": 0, "term_id": 1},
    )
    if pre and pre.get("term_id"):
        t = await db[COL_TERMS].find_one(
            {"term_id": pre["term_id"]},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        )
        if t:
            return t

    current = await db[COL_TERMS].find_one(
        {"$or": [{"status": "active"}, {"is_current": True}]},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )

    if not current:
        last = (
            await db[COL_TERMS]
            .find({}, {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1})
            .sort([("acad_year_start", -1), ("term_number", -1)])
            .limit(1)
            .to_list(1)
        )
        return last[0] if last else {}

    next_terms = (
        await db[COL_TERMS]
        .find(
            {
                "$or": [
                    {"acad_year_start": {"$gt": current["acad_year_start"]}},
                    {
                        "acad_year_start": current["acad_year_start"],
                        "term_number": {"$gt": current["term_number"]},
                    },
                ]
            },
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        )
        .sort([("acad_year_start", 1), ("term_number", 1)])
        .limit(1)
        .to_list(1)
    )
    return next_terms[0] if next_terms else current


async def _get_allowed_statuses() -> List[str]:
    return OM_ALLOWED_STATUSES


async def _faculty_name_from_id(faculty_id: Optional[str]) -> str:
    if not faculty_id:
        return "UNASSIGNED"
    prof = await db[COL_FAC_PROFILES].find_one(
        {"faculty_id": faculty_id},
        {"_id": 0, "user_id": 1},
    )
    if not prof or not prof.get("user_id"):
        return "UNASSIGNED"
    u = await db[COL_USERS].find_one(
        {"$or": [{"user_id": prof["user_id"]}, {"userId": prof["user_id"]}]},
        {"_id": 0, "first_name": 1, "last_name": 1, "firstName": 1, "lastName": 1},
    )
    if not u:
        return "UNASSIGNED"
    return _upper_name(
        u.get("first_name") or u.get("firstName") or "",
        u.get("last_name") or u.get("lastName") or "",
    )


async def _latest_faculty_assignment_for_section(section_id: str) -> Dict[str, Optional[str]]:
    rows = (
        await db[COL_FAC_ASSIGN]
        .find(
            {"section_id": section_id, "is_archived": {"$ne": True}},
            {"_id": 0, "faculty_id": 1, "assignment_id": 1},
        )
        .sort([("created_at", -1)])
        .limit(1)
        .to_list(1)
    )
    if not rows:
        return {"faculty_id": None, "assignment_id": None}
    r = rows[0] or {}
    return {
        "faculty_id": r.get("faculty_id") or None,
        "assignment_id": r.get("assignment_id") or None,
    }

async def _schedule_ids_for_section(section_id: str) -> Tuple[Optional[str], Optional[str]]:
    rows = (
        await db[COL_SECTION_SCHEDULES]
        .find({"section_id": section_id}, {"_id": 0, "schedule_id": 1})
        .sort("schedule_id", ASCENDING)
        .to_list(50)
    )
    ids = [r.get("schedule_id") for r in rows if r.get("schedule_id")]
    sid1 = ids[0] if len(ids) >= 1 else None
    sid2 = ids[1] if len(ids) >= 2 else None
    return sid1, sid2


async def _section_schedule_two_from_schedule_ids(
    schedule_id1: Optional[str],
    schedule_id2: Optional[str],
) -> Dict[str, str]:
    ids = [x for x in [schedule_id1, schedule_id2] if x]
    if not ids:
        return {"day1": "", "begin1": "", "end1": "", "day2": "", "begin2": "", "end2": ""}

    rows = await db[COL_SECTION_SCHEDULES].find(
        {"schedule_id": {"$in": ids}},
        {"_id": 0, "schedule_id": 1, "day": 1, "start_time": 1, "end_time": 1},
    ).to_list(10)

    # keep stable order by schedule_id
    rows.sort(key=lambda r: (r.get("schedule_id") or ""))

    entries: List[Tuple[str, str, str]] = []
    for r in rows:
        d = _normalize_day(r.get("day"))
        if d not in ALLOWED_DAYS:
            continue
        st = _to_hhmm(r.get("start_time"))
        et = _to_hhmm(r.get("end_time"))
        if not (_is_valid_hhmm(st) and _is_valid_hhmm(et)):
            continue
        if _mins(et) <= _mins(st):
            continue
        entries.append((d, st, et))

    out = {"day1": "", "begin1": "", "end1": "", "day2": "", "begin2": "", "end2": ""}
    if len(entries) >= 1:
        out["day1"], out["begin1"], out["end1"] = entries[0]
    if len(entries) >= 2:
        out["day2"], out["begin2"], out["end2"] = entries[1]
    return out


async def _next_seq_id(coll: str, id_field: str, prefix: str, width: int) -> str:
    # expects ids like SEC0001 / SCH0001-01 is NOT used here (only base ids like SEC/ASG)
    regex = f"^{prefix}[0-9]{{{width}}}$"
    last = (
        await db[coll]
        .find({id_field: {"$regex": regex}}, {"_id": 0, id_field: 1})
        .sort(id_field, -1)
        .limit(1)
        .to_list(1)
    )
    if not last:
        n = 1
    else:
        s = str(last[0].get(id_field) or "")
        try:
            n = int(s.replace(prefix, "")) + 1
        except Exception:
            n = 1
    return f"{prefix}{n:0{width}d}"


async def _maybe_load_id_for_faculty(term_id: str, faculty_id: str) -> str:
    # best-effort: get dept_id from faculty_profiles then find faculty_loads for that dept+term
    prof = await db[COL_FAC_PROFILES].find_one(
        {"faculty_id": faculty_id},
        {"_id": 0, "department_id": 1},
    )
    dept_id = (prof or {}).get("department_id")
    if not dept_id:
        return ""

    load = await db[COL_FAC_LOADS].find_one(
        {"term_id": term_id, "department_id": dept_id},
        {"_id": 0, "load_id": 1},
    )
    return (load or {}).get("load_id") or ""


async def _create_custom_section_bundle(
    *,
    term_id: str,
    course_id: str,
    section_code: str,
    sched: Dict[str, str],
    faculty_id: str,
) -> Dict[str, Optional[str]]:
    """
    Creates:
      - sections (SECxxxx)
      - section_schedules (SCHxxxx-01/02)
      - faculty_assignments (ASGxxxx)
    Returns ids to store on special_class:
      section_id, schedule_id1, schedule_id2, assignment_id
    """
    section_code = (section_code or "").strip().upper()
    if not section_code:
        raise HTTPException(status_code=400, detail="section_code is required for custom schedule.")

    # must have at least one valid schedule entry
    if not (sched.get("day1") and sched.get("begin1") and sched.get("end1")) and not (
        sched.get("day2") and sched.get("begin2") and sched.get("end2")
    ):
        raise HTTPException(status_code=400, detail="At least one schedule entry is required for custom schedule.")

    faculty_id = (faculty_id or "").strip()
    if not faculty_id:
        raise HTTPException(status_code=400, detail="faculty_id is required for custom schedule.")

    now = datetime.utcnow()

    # --- create section ---
    section_id = await _next_seq_id(COL_SECTIONS, "section_id", "SEC", 4)
    sec_doc = {
        "section_id": section_id,
        "section_code": section_code,
        "term_id": term_id,
        "course_id": course_id,
        "enrollment_cap": 45,
        "enrolled": 0,
        "batch_number": 0,
        "status": "active",
        "remarks": "SPECIAL CLASS",
        "created_at": now,
        "updated_at": now,
    }
    await db[COL_SECTIONS].insert_one(sec_doc)

    # --- create schedules ---
    # SEC0007 -> SCH0007-01 / SCH0007-02
    try:
        sec_num = int(section_id.replace("SEC", ""))
    except Exception:
        sec_num = 0
    sch_base = f"SCH{sec_num:04d}"

    def _hhmm_to_db(hhmm: str) -> str:
        # store like sample: "730" not "0730"
        s = _to_hhmm(hhmm)
        if not s:
            return ""
        try:
            return str(int(s))
        except Exception:
            return s

    schedule_id1: Optional[str] = None
    schedule_id2: Optional[str] = None
    sched_docs: List[Dict[str, Any]] = []

    if sched.get("day1") and sched.get("begin1") and sched.get("end1"):
        schedule_id1 = f"{sch_base}-01"
        sched_docs.append(
            {
                "schedule_id": schedule_id1,
                "section_id": section_id,
                "day": sched["day1"],
                "start_time": _hhmm_to_db(sched["begin1"]),
                "end_time": _hhmm_to_db(sched["end1"]),
                "room_id": None,
                "room_type": "Online",
                "created_at": now,
                "updated_at": now,
            }
        )

    if sched.get("day2") and sched.get("begin2") and sched.get("end2"):
        schedule_id2 = f"{sch_base}-02"
        sched_docs.append(
            {
                "schedule_id": schedule_id2,
                "section_id": section_id,
                "day": sched["day2"],
                "start_time": _hhmm_to_db(sched["begin2"]),
                "end_time": _hhmm_to_db(sched["end2"]),
                "room_id": None,
                "room_type": "Online",
                "created_at": now,
                "updated_at": now,
            }
        )

    if sched_docs:
        await db[COL_SECTION_SCHEDULES].insert_many(sched_docs)

    # --- create faculty assignment ---
    assignment_id = await _next_seq_id(COL_FAC_ASSIGN, "assignment_id", "ASG", 4)
    load_id = await _maybe_load_id_for_faculty(term_id, faculty_id)

    asg_doc = {
        "assignment_id": assignment_id,
        "load_id": load_id,
        "section_id": section_id,
        "faculty_id": faculty_id,
        "created_at": now,
        "is_archived": False,
    }
    await db[COL_FAC_ASSIGN].insert_one(asg_doc)

    return {
        "section_id": section_id,
        "schedule_id1": schedule_id1,
        "schedule_id2": schedule_id2,
        "assignment_id": assignment_id,
    }

async def _section_schedule_two(section_id: str) -> Dict[str, str]:
    rows = await db[COL_SECTION_SCHEDULES].find(
        {"section_id": section_id},
        {"_id": 0, "day": 1, "start_time": 1, "end_time": 1},
    ).to_list(50)

    entries: List[Tuple[str, str, str]] = []
    for r in rows:
        d = _normalize_day(r.get("day"))
        if d not in ALLOWED_DAYS:
            continue
        st = _to_hhmm(r.get("start_time"))
        et = _to_hhmm(r.get("end_time"))
        if not (_is_valid_hhmm(st) and _is_valid_hhmm(et)):
            continue
        if _mins(et) <= _mins(st):
            continue
        entries.append((d, st, et))

    entries.sort(key=lambda x: (DAY_ORDER.get(x[0], 99), x[1]))
    entries = entries[:2]

    out = {"day1": "", "begin1": "", "end1": "", "day2": "", "begin2": "", "end2": ""}
    if len(entries) >= 1:
        out["day1"], out["begin1"], out["end1"] = entries[0]
    if len(entries) >= 2:
        out["day2"], out["begin2"], out["end2"] = entries[1]
    return out


async def _build_faculty_options() -> List[Dict[str, Any]]:
    profs = await db[COL_FAC_PROFILES].find(
        {},
        {"_id": 0, "faculty_id": 1, "user_id": 1, "department_id": 1},
    ).to_list(10000)

    uids = [p.get("user_id") for p in profs if p.get("user_id")]
    users = await db[COL_USERS].find(
        {"$or": [{"user_id": {"$in": uids}}, {"userId": {"$in": uids}}]},
        {
            "_id": 0,
            "user_id": 1,
            "userId": 1,
            "first_name": 1,
            "last_name": 1,
            "firstName": 1,
            "lastName": 1,
        },
    ).to_list(10000)

    umap: Dict[str, Dict[str, Any]] = {}
    for u in users:
        key = u.get("user_id") or u.get("userId")
        if key:
            umap[key] = u

    out: List[Dict[str, Any]] = []
    for p in profs:
        fid = (p.get("faculty_id") or "").strip()
        if not fid:
            continue
        u = umap.get(p.get("user_id") or "", {})
        nm = _upper_name(
            u.get("first_name") or u.get("firstName") or "",
            u.get("last_name") or u.get("lastName") or "",
        )
        out.append(
            {
                "faculty_id": fid,
                "faculty_name": nm,
                "department_id": p.get("department_id"),
            }
        )

    out.sort(key=lambda x: x.get("faculty_name") or "")
    return out


async def _schedule_presets(term_id: str, course_id: str) -> List[Dict[str, Any]]:
    secs = await db[COL_SECTIONS].find(
        {"term_id": term_id, "course_id": course_id},
        {"_id": 0, "section_id": 1, "section_code": 1},
    ).sort("section_code", ASCENDING).to_list(5000)

    out: List[Dict[str, Any]] = []
    for s in secs:
        sid = s.get("section_id")
        if not sid:
            continue
        df = await _section_schedule_two(sid)
        label = (f"{df['day1']} {df['begin1']}-{df['end1']}" if df.get("day1") else "") or "TBA"

        fac = await _latest_faculty_assignment_for_section(sid)
        fac_id = fac.get("faculty_id")
        fac_name = await _faculty_name_from_id(fac_id)

        sid1, sid2 = await _schedule_ids_for_section(sid)
        out.append(
            {
                # keep schedule_id as selection key (frontend expects a single string)
                "schedule_id": sid,
                "section_id": sid,
                "section_code": s.get("section_code") or "",
                "label": label,
                "faculty_id": fac_id,
                "faculty_name": fac_name,

                # ids to store on special_class (no day/begin fields stored there)
                "schedule_id1": sid1,
                "schedule_id2": sid2,
                "assignment_id": fac.get("assignment_id"),

                # still return display fields for UI
                **df,
            }
        )


    out.sort(key=lambda x: (x.get("label") or "", x.get("section_code") or ""))
    return out


async def _bulk_maps_for_rows(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    uids = sorted({(r.get("user_id") or r.get("userId") or "").strip() for r in rows if (r.get("user_id") or r.get("userId"))})
    pids = sorted({(r.get("program_id") or r.get("programId") or "").strip() for r in rows if (r.get("program_id") or r.get("programId"))})
    dids = sorted({(r.get("department_id") or r.get("departmentId") or "").strip() for r in rows if (r.get("department_id") or r.get("departmentId"))})
    cids = sorted({(r.get("course_id") or r.get("courseId") or "").strip() for r in rows if (r.get("course_id") or r.get("courseId"))})
    sids = sorted({(r.get("section_id") or "").strip() for r in rows if r.get("section_id")})

    users = await db[COL_USERS].find(
        {"$or": [{"user_id": {"$in": uids}}, {"userId": {"$in": uids}}]},
        {"_id": 0, "user_id": 1, "userId": 1, "first_name": 1, "last_name": 1, "firstName": 1, "lastName": 1},
    ).to_list(20000)

    programs = await db[COL_PROGRAMS].find(
        {"program_id": {"$in": pids}},
        {"_id": 0, "program_id": 1, "program_code": 1},
    ).to_list(20000)

    departments = await db[COL_DEPARTMENTS].find(
        {"department_id": {"$in": dids}},
        {"_id": 0, "department_id": 1, "department_name": 1, "dept_name": 1},
    ).to_list(20000)

    courses = await db[COL_COURSES].find(
        {"course_id": {"$in": cids}},
        {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1, "units": 1},
    ).to_list(20000)

    sections = await db[COL_SECTIONS].find(
        {"section_id": {"$in": sids}},
        {"_id": 0, "section_id": 1, "section_code": 1},
    ).to_list(20000)

    umap: Dict[str, Dict[str, Any]] = {}
    for u in users:
        key = u.get("user_id") or u.get("userId")
        if key:
            umap[key] = u

    pmap = {p["program_id"]: p for p in programs if p.get("program_id")}
    dmap = {d["department_id"]: d for d in departments if d.get("department_id")}
    cmap = {c["course_id"]: c for c in courses if c.get("course_id")}
    smap = {s["section_id"]: s for s in sections if s.get("section_id")}

    return {"umap": umap, "pmap": pmap, "dmap": dmap, "cmap": cmap, "smap": smap}


async def _shape_row(r: Dict[str, Any], maps: Dict[str, Any]) -> Dict[str, Any]:
    uid = (r.get("user_id") or r.get("userId") or "").strip()
    pid = (r.get("program_id") or r.get("programId") or "").strip()
    did = (r.get("department_id") or r.get("departmentId") or "").strip()
    cid = (r.get("course_id") or r.get("courseId") or "").strip()
    sid = (r.get("section_id") or "").strip() or None

    status = (r.get("status") or "").strip()
    status_norm = status.upper()

    u = (maps["umap"].get(uid) or {}) if uid else {}
    p = (maps["pmap"].get(pid) or {}) if pid else {}
    d = (maps["dmap"].get(did) or {}) if did else {}
    c = (maps["cmap"].get(cid) or {}) if cid else {}
    s = (maps["smap"].get(sid) or {}) if sid else {}

    student_name = _upper_name(
        u.get("first_name") or u.get("firstName") or "",
        u.get("last_name") or u.get("lastName") or "",
    )

    course_code = c.get("course_code") or ""
    if isinstance(course_code, list):
        course_code = (course_code[0] if course_code else "") or ""

    course_units = r.get("course_units", "")
    if course_units in (None, "", 0):
        course_units = c.get("units", "") or ""

    section_code = (s.get("section_code") or "").strip() if sid else ""

    # schedule is derived by IDs (schedule_id1/2) if present, else by section_id
    schedule_id1 = (r.get("schedule_id1") or "").strip() or None
    schedule_id2 = (r.get("schedule_id2") or "").strip() or None

    if schedule_id1 or schedule_id2:
        df = await _section_schedule_two_from_schedule_ids(schedule_id1, schedule_id2)
    elif sid:
        df = await _section_schedule_two(sid)
    else:
        # backward-compat only (old rows)
        df = {
            "day1": _normalize_day(r.get("day1")),
            "begin1": _to_hhmm(r.get("begin1")),
            "end1": _to_hhmm(r.get("end1")),
            "day2": _normalize_day(r.get("day2")),
            "begin2": _to_hhmm(r.get("begin2")),
            "end2": _to_hhmm(r.get("end2")),
        }

    # faculty derived by assignment_id first; fallback to latest assignment for section
    assignment_id = (r.get("assignment_id") or r.get("faculty_assignment_id") or "").strip() or None

    faculty_id: Optional[str] = None
    faculty_name = "UNASSIGNED"

    if status_norm == "SUBMITTED":
        faculty_id = None
        faculty_name = "UNASSIGNED"
    else:
        if assignment_id:
            asg = await db[COL_FAC_ASSIGN].find_one(
                {"assignment_id": assignment_id, "is_archived": {"$ne": True}},
                {"_id": 0, "faculty_id": 1},
            )
            faculty_id = (asg or {}).get("faculty_id") or None
        elif sid:
            fa = await _latest_faculty_assignment_for_section(sid)
            faculty_id = fa.get("faculty_id")

        faculty_name = await _faculty_name_from_id(faculty_id)


    return {
        "special_id": r.get("special_id"),
        "term_id": r.get("term_id"),
        "user_id": uid,
        "student_name": student_name,
        "student_number": r.get("student_number", ""),
        "course_id": cid,
        "course_code": course_code,
        "course_title": c.get("course_title") or "",
        "course_department": d.get("department_name") or d.get("dept_name") or "",
        "program_id": pid,
        "program_code": p.get("program_code") or "",
        "reason": r.get("reason") or "",
        "reason_other": r.get("reason_other") or "",
        "status": status,
        "remarks": r.get("remarks") or "",
        "faculty_id": faculty_id,
        "faculty_name": faculty_name,
        "section_id": sid,
        "section_code": section_code,
        "day1": df.get("day1") or "",
        "begin1": df.get("begin1") or "",
        "end1": df.get("end1") or "",
        "day2": df.get("day2") or "",
        "begin2": df.get("begin2") or "",
        "end2": df.get("end2") or "",
        "submitted_at": r.get("submitted_at"),
        "updated_at": r.get("updated_at"),
        "department_id": did,
        "department_name": d.get("department_name") or d.get("dept_name") or "",
        "course_units": course_units,
        "units_remaining": r.get("units_remaining", ""),
        "graduating_after_term": bool(r.get("graduating_after_term", False)),
        "schedule_text": r.get("schedule_text", ""),
    }


# ---------------- PDF drawing helpers (NO IMAGE TEMPLATE) ----------------
PAGE_W, PAGE_H = (RL_A4 if RL_A4 else (595.2756, 841.8898))


def _hhmm_colon(hhmm: str) -> str:
    s = (hhmm or "").strip()
    if len(s) == 4 and s.isdigit():
        return f"{s[:2]}:{s[2:]}"
    return ""


def _schedule_line(r: Dict[str, Any]) -> str:
    parts: List[str] = []
    if r.get("day1") and r.get("begin1") and r.get("end1"):
        parts.append(f"{r['day1']} {_hhmm_colon(r['begin1'])}-{_hhmm_colon(r['end1'])}")
    if r.get("day2") and r.get("begin2") and r.get("end2"):
        parts.append(f"{r['day2']} {_hhmm_colon(r['begin2'])}-{_hhmm_colon(r['end2'])}")
    return "; ".join([p for p in parts if p.strip()])


def _term_ay_label(term: Dict[str, Any]) -> str:
    tn = term.get("term_number")
    ay = term.get("acad_year_start")
    if ay:
        return f"Term {tn or ''} / AY {ay}-{ay+1}"
    return f"Term {tn or ''}".strip()


def _split_student_name(student_name_upper: str) -> Tuple[str, str, str]:
    s = (student_name_upper or "").strip()
    if "," in s:
        last, rest = s.split(",", 1)
        rest = rest.strip()
        return (last.strip(), rest, "")
    return (s, "", "")


def _reason_index(reason: str, reason_other: str) -> int:
    r = (reason or "").strip().lower()
    ro = (reason_other or "").strip()
    if "not offered" in r and "graduating" in r and ("conflict" not in r):
        return 0
    if "conflict" in r:
        return 1
    if "flowchart" in r and "not offered" in r:
        return 2
    if ro or "other" in r:
        return 3
    return -1


def _fit_and_draw_text(
    c,
    text: str,
    x: float,
    y: float,
    w: float,
    h: float,
    font: str = "Helvetica",
    max_size: int = 10,
    min_size: int = 7,
    leading_ratio: float = 1.15,
    align: str = "left",
    valign: str = "middle",
):
    t = "" if text is None else str(text).strip()
    if not t:
        return

    raw_lines = []
    for para in t.split("\n"):
        raw_lines.append(para.strip())

    def wrap_lines(size: int) -> List[str]:
        lines: List[str] = []
        for para in raw_lines:
            if not para:
                lines.append("")
                continue
            words = para.split()
            cur = ""
            for wrd in words:
                cand = (cur + " " + wrd).strip()
                if c.stringWidth(cand, font, size) <= w:
                    cur = cand
                else:
                    if cur:
                        lines.append(cur)
                    cur = wrd
            if cur:
                lines.append(cur)
        return lines

    chosen_size = max_size
    chosen_lines = wrap_lines(chosen_size)
    while chosen_size > min_size:
        leading = chosen_size * leading_ratio
        total_h = len(chosen_lines) * leading
        if total_h <= h + 0.01:
            break
        chosen_size -= 1
        chosen_lines = wrap_lines(chosen_size)

    leading = chosen_size * leading_ratio
    total_h = len(chosen_lines) * leading

    if valign == "top":
        start_y = y + h - leading
    elif valign == "bottom":
        start_y = y + (len(chosen_lines) - 1) * leading
    else:
        start_y = y + (h + total_h) / 2 - leading

    c.setFont(font, chosen_size)

    for i, line in enumerate(chosen_lines):
        yy = start_y - i * leading
        if align == "center":
            c.drawCentredString(x + w / 2, yy, line)
        elif align == "right":
            c.drawRightString(x + w, yy, line)
        else:
            c.drawString(x, yy, line)


def _draw_rect(c, x, y, w, h, stroke=1, fill=0):
    c.rect(x, y, w, h, stroke=stroke, fill=fill)


def _fill_rect(c, x, y, w, h, fill_color):
    c.setFillColor(fill_color)
    c.rect(x, y, w, h, stroke=0, fill=1)
    c.setFillColor(colors.black)


def _draw_checkbox(c, x, y, size=10, checked=False):
    _draw_rect(c, x, y, size, size, stroke=1, fill=0)
    if checked:
        pad = max(1.5, size * 0.22)
        c.setLineWidth(1.4)
        c.line(x + pad, y + pad, x + size - pad, y + size - pad)
        c.line(x + pad, y + size - pad, x + size - pad, y + pad)
        c.setLineWidth(1)


def _render_one_application(c, r: Dict[str, Any], active_term: Dict[str, Any]):
    BLACK = colors.black
    WHITE = colors.white

    margin = 24
    x0 = margin
    y0 = margin
    W = PAGE_W - 2 * margin
    H = PAGE_H - 2 * margin

    # ---- Header ----
    term_lbl = _term_ay_label(active_term)
    c.setFont("Helvetica-Bold", 10)
    c.drawRightString(x0 + W, y0 + H - 6, "EN-05-201904")
    c.setFont("Helvetica", 9)
    c.drawRightString(x0 + W, y0 + H - 20, term_lbl)

    c.setFont("Helvetica-Bold", 18)
    c.drawCentredString(x0 + W / 2, y0 + H - 50, "APPLICATION FOR SPECIAL CLASS")
    c.setLineWidth(2)
    c.line(x0 + W * 0.25, y0 + H - 54, x0 + W * 0.75, y0 + H - 54)
    c.setLineWidth(1)

    c.setFont("Helvetica-Bold", 10)
    c.drawString(x0, y0 + H - 80, "PLEASE PRINT")
    c.setFont("Helvetica-Bold", 10)
    c.drawRightString(x0 + W, y0 + H - 80, "Term / AY ____________")

    # ---- Personal + Academic blocks ----
    top = y0 + H - 100
    block_h = 140
    _draw_rect(c, x0, top - block_h, W, block_h, stroke=1, fill=0)

    bar_h = 26
    _fill_rect(c, x0, top - bar_h, W, bar_h, BLACK)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 11)
    c.drawCentredString(x0 + W * 0.25, top - bar_h + 8, "PERSONAL INFORMATION")
    c.drawCentredString(x0 + W * 0.75, top - bar_h + 8, "ACADEMIC INFORMATION")
    c.setFillColor(BLACK)

    mid_x = x0 + W / 2
    c.line(mid_x, top - block_h, mid_x, top)

    row_h = (block_h - bar_h) / 4
    for i in range(1, 4):
        y_line = top - bar_h - i * row_h
        c.line(x0, y_line, x0 + W, y_line)

    left_w = W / 2
    left_label_w = left_w * 0.38
    c.line(x0 + left_label_w, top - bar_h, x0 + left_label_w, top - block_h)

    right_x = mid_x
    right_w = W / 2
    right_label_w = right_w * 0.48
    c.line(right_x + right_label_w, top - bar_h, right_x + right_label_w, top - block_h)

    c.setFont("Helvetica-Bold", 10)
    left_labels = ["LAST NAME", "FIRST NAME", "MIDDLE NAME", "UNITS REMAINING INCLUDING CURRENT TERM:"]
    right_labels = ["ID NUMBER", "COLLEGE", "COURSE", "GRADUATING AFTER THIS\nTERM?"]

    for i, lab in enumerate(left_labels):
        yy = top - bar_h - (i + 1) * row_h
        _fit_and_draw_text(c, lab, x0 + 8, yy + 3, left_label_w - 12, row_h - 6, font="Helvetica-Bold", max_size=9, min_size=7)

    for i, lab in enumerate(right_labels):
        yy = top - bar_h - (i + 1) * row_h
        _fit_and_draw_text(c, lab, right_x + 8, yy + 3, right_label_w - 12, row_h - 6, font="Helvetica-Bold", max_size=9, min_size=7)

    last_name, first_name, middle_name = _split_student_name(r.get("student_name", ""))
    id_number = str(r.get("student_number") or "").strip()
    college = (r.get("department_name") or r.get("course_department") or "").strip()
    course = (r.get("program_code") or "").strip()
    units_remaining = str(r.get("units_remaining") or "").strip()

    for i, val in enumerate([last_name, first_name, middle_name, units_remaining]):
        yy = top - bar_h - (i + 1) * row_h
        _fit_and_draw_text(c, val, x0 + left_label_w + 8, yy + 3, left_w - left_label_w - 16, row_h - 6, font="Helvetica", max_size=10, min_size=8)

    for i, val in enumerate([id_number, college, course, ""]):
        yy = top - bar_h - (i + 1) * row_h
        if i < 3:
            _fit_and_draw_text(c, val, right_x + right_label_w + 8, yy + 3, right_w - right_label_w - 16, row_h - 6, font="Helvetica", max_size=10, min_size=8)

    grad_yes = bool(r.get("graduating_after_term", False))
    grad_row_y = top - bar_h - 4 * row_h
    box_area_x = right_x + right_label_w + 8

    cb = 11
    gap = 2
    total_h = (cb * 2) + gap
    box_area_y = grad_row_y + max(0, (row_h - total_h) / 2)

    y_no = box_area_y
    y_yes = box_area_y + cb + gap

    _draw_checkbox(c, box_area_x, y_yes, size=cb, checked=grad_yes)
    _draw_checkbox(c, box_area_x, y_no, size=cb, checked=(not grad_yes))

    c.setFont("Helvetica-Bold", 10)
    c.drawString(box_area_x + cb + 6, y_yes + 1, "YES")
    c.drawString(box_area_x + cb + 6, y_no + 1, "NO")

    # ---- Special class applied for ----
    sc_top = top - block_h - 10
    bar_h2 = 26
    _fill_rect(c, x0, sc_top - bar_h2, W, bar_h2, BLACK)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 12)
    c.drawCentredString(x0 + W / 2, sc_top - bar_h2 + 8, "SPECIAL CLASS APPLIED FOR")
    c.setFillColor(BLACK)

    hdr_h = 22
    sc_tbl_top = sc_top - bar_h2
    _fill_rect(c, x0, sc_tbl_top - hdr_h, W, hdr_h, BLACK)
    _draw_rect(c, x0, sc_tbl_top - hdr_h, W, hdr_h, stroke=1, fill=0)

    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 10)
    col1 = W * 0.58
    col2 = W * 0.22
    col3 = W - col1 - col2
    c.drawCentredString(x0 + col1 / 2, sc_tbl_top - hdr_h + 6, "COURSE TITLE")
    c.drawCentredString(x0 + col1 + col2 / 2, sc_tbl_top - hdr_h + 6, "COURSE CODE")
    c.drawCentredString(x0 + col1 + col2 + col3 / 2, sc_tbl_top - hdr_h + 6, "UNITS")
    c.setFillColor(BLACK)

    val_h = 36
    y_val = sc_tbl_top - hdr_h - val_h
    _draw_rect(c, x0, y_val, W, val_h, stroke=1, fill=0)
    c.line(x0 + col1, y_val, x0 + col1, y_val + val_h)
    c.line(x0 + col1 + col2, y_val, x0 + col1 + col2, y_val + val_h)

    course_title = (r.get("course_title") or "").strip()
    course_code2 = (r.get("course_code") or "").strip()
    course_units = str(r.get("course_units") or "").strip()

    schedule_txt = (r.get("schedule_text") or "").strip() or _schedule_line(r)
    _fit_and_draw_text(c, course_title, x0 + 8, y_val + 16, col1 - 16, 18, font="Helvetica", max_size=10, min_size=8)
    if schedule_txt:
        _fit_and_draw_text(c, f"Schedule: {schedule_txt}", x0 + 8, y_val + 2, col1 - 16, 14, font="Helvetica", max_size=8, min_size=7, valign="bottom")

    _fit_and_draw_text(c, course_code2, x0 + col1 + 6, y_val + 6, col2 - 12, val_h - 12, font="Helvetica-Bold", max_size=10, min_size=8, align="center")
    _fit_and_draw_text(c, course_units, x0 + col1 + col2, y_val + 6, col3, val_h - 12, font="Helvetica-Bold", max_size=10, min_size=8, align="center")

    # ---- Reason section ----
    reason_top = y_val - 10
    reason_h = 120
    _draw_rect(c, x0, reason_top - reason_h, W, reason_h, stroke=1, fill=0)

    left_reason_w = W * 0.48
    c.line(x0 + left_reason_w, reason_top - reason_h, x0 + left_reason_w, reason_top)

    _fill_rect(c, x0, reason_top - reason_h, left_reason_w, reason_h, BLACK)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 12)
    c.drawCentredString(x0 + left_reason_w / 2, reason_top - reason_h / 2 - 6, "REASON FOR SPECIAL CLASS")
    c.setFillColor(BLACK)

    rx = x0 + left_reason_w
    rw = W - left_reason_w
    idx = _reason_index(r.get("reason", ""), r.get("reason_other", ""))

    c.setFont("Helvetica", 9)
    cb_size = 12
    start_y = reason_top - 22
    line_gap = 24
    for i, line in enumerate(REASON_LINES):
        yy = start_y - i * line_gap
        _draw_checkbox(c, rx + 12, yy - 8, size=cb_size, checked=(i == idx))
        _fit_and_draw_text(
            c,
            line,
            rx + 12 + cb_size + 8,
            yy - 18,
            rw - (12 + cb_size + 28),
            22,
            font="Helvetica",
            max_size=9,
            min_size=7,
        )

    if idx == 3 and (r.get("reason_other") or "").strip():
        _fit_and_draw_text(
            c,
            (r.get("reason_other") or "").strip(),
            rx + 12 + cb_size + 8,
            (start_y - 3 * line_gap) - 40,
            rw - (12 + cb_size + 28),
            18,
            font="Helvetica-Oblique",
            max_size=8,
            min_size=7,
            valign="top",
        )

    # ---- Terms and Conditions ----
    tc_top = reason_top - reason_h - 10
    tc_h = 100
    _draw_rect(c, x0, tc_top - tc_h, W, tc_h, stroke=1, fill=0)
    _draw_rect(c, x0, tc_top - 22, W, 22, stroke=1, fill=0)
    c.setFont("Helvetica-Bold", 11)
    c.drawCentredString(x0 + W / 2, tc_top - 16, "TERMS AND CONDITIONS")

    tc_lines = [
        "1.  This form must be accomplished in duplicate (2 copies) and submitted to the Academic Programming Officer (APO) of the",
        "    College/ School for processing when ALL signatures of approving authorities are complete.",
        "2.  A processing fee of P150.00 per application will be charged. A copy of the official receipt must be submitted to the APO.",
        "3.  The application shall be deemed final and valid upon inclusion of the special class in the student's official enrollment record.",
        "    Student can no longer withdraw the application. It is therefore important for the student to secure/print an updated Enrollment",
        "    Assessment Form to verify.",
        "4.  All stated deadlines contained in the Procedure for Special Class Application must be complied with.",
    ]
    _fit_and_draw_text(
        c,
        "\n".join(tc_lines),
        x0 + 12,
        tc_top - tc_h + 8,
        W - 24,
        tc_h - 30,
        font="Helvetica",
        max_size=8,
        min_size=7,
        valign="top",
    )

    # signature line
    sig_y = tc_top - tc_h - 18
    c.setLineWidth(1)
    c.line(x0 + W * 0.35, sig_y, x0 + W * 0.65, sig_y)
    c.setFont("Helvetica-BoldOblique", 9)
    c.drawCentredString(x0 + W / 2, sig_y - 12, "STUDENT'S SIGNATURE OVER PRINTED NAME / DATE")

    # ---- Footer reserved space (avoid clipping) ----
    footer_h = 22
    footer_top_y = y0 + footer_h
    min_bottom = footer_top_y + 6

    # ===================== APPROVAL (MATCH REFERENCE) =====================
    ap_top = sig_y - 22
    ap_h_target = 140
    ap_h = ap_h_target
    if (ap_top - ap_h) < min_bottom:
        ap_h = max(112, ap_top - min_bottom)

    _draw_rect(c, x0, ap_top - ap_h, W, ap_h, stroke=1, fill=0)

    header_h = 28
    _fill_rect(c, x0, ap_top - header_h, W, header_h, BLACK)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 14)
    c.drawCentredString(x0 + W / 2, ap_top - 18, "APPROVAL")
    c.setFont("Helvetica-Oblique", 9)
    c.drawCentredString(x0 + W / 2, ap_top - 26, "(ACCOMPLISH IN SEQUENCE)")
    c.setFillColor(BLACK)

    body_top = ap_top - header_h
    body_bottom = ap_top - ap_h
    body_h = body_top - body_bottom

    left_w2 = W * 0.46
    div_x = x0 + left_w2

    right_x0 = div_x
    right_x1 = x0 + W
    right_w2 = right_x1 - right_x0

    # right strip (ONLY for the top area where "3" lives)
    strip_w = max(52.0, right_w2 * 0.18)
    sub_div_x = right_x1 - strip_w

    # main vertical divider across full approval body
    c.line(div_x, body_bottom, div_x, body_top)

    # horizontal divider across full width
    split_y = body_bottom + body_h * 0.55
    c.line(x0, split_y, x0 + W, split_y)

    # bottom-right: black bar "FOR APO USE ONLY" + white space below (no extra column)
    apo_bar_h = 22
    _fill_rect(c, right_x0, split_y - apo_bar_h, right_w2, apo_bar_h, BLACK)
    c.setFillColor(WHITE)
    c.setFont("Helvetica-Bold", 10)
    c.drawCentredString(right_x0 + right_w2 / 2, split_y - apo_bar_h + 7, "FOR APO USE ONLY")
    c.setFillColor(BLACK)

    # LEFT: Associate Dean
    c.setFont("Helvetica-Bold", 10)
    c.drawString(x0 + 8, body_top - 16, "ASSOCIATE DEAN")

    # LEFT-bottom
    c.setFont("Helvetica-Bold", 9)
    c.drawString(x0 + 8, split_y - 12, "(DEPARTMENT) I am appointing (faculty)")
    c.drawString(x0 + 8, split_y - 24, "MR/MS/DR")
    c.line(x0 + 62, split_y - 26, div_x - 12, split_y - 26)

    # faculty name after MR/MS/DR
    fac_name = (r.get("faculty_name") or "").strip()
    if fac_name.upper() == "UNASSIGNED":
        fac_name = ""
    if fac_name:
        name_x = x0 + 62 + 2
        name_w = (div_x - 12) - name_x
        name_y = (split_y - 26) + 2
        _fit_and_draw_text(
            c,
            fac_name,
            name_x,
            name_y,
            name_w,
            14,
            font="Helvetica-Bold",
            max_size=9,
            min_size=7,
            align="left",
            valign="middle",
        )

    # Chair signature line + label
    chair_line_y = body_bottom + 24
    c.line(x0 + 40, chair_line_y, div_x - 40, chair_line_y)
    c.setFont("Helvetica-BoldOblique", 9)
    c.drawCentredString(x0 + left_w2 / 2, chair_line_y - 12, "SIGNATURE OF CHAIR / COORDINATOR / DATE")

    # number boxes
    nb = 18

    # Box 1 (ASSOCIATE DEAN) - inside LEFT cell near the divider
    box1_x = div_x - nb - 2
    box1_y = body_top - nb - 2
    _draw_rect(c, box1_x, box1_y, nb, nb, stroke=1, fill=0)
    c.setFont("Helvetica-Bold", 10)
    c.drawCentredString(box1_x + nb / 2, box1_y + 5, "1")


    # Faculty signature line (top area; line only)
    fx = div_x + nb + 18
    if fx < div_x + 28:
        fx = div_x + 28
    fx2 = right_x1 - 16
    total_w = max(120.0, fx2 - fx)

    fac_box_h = 16
    fac_box_y = body_top - 52
    if fac_box_y < (split_y + 12):
        fac_box_y = split_y + 12
    max_fac_y = (body_top - 18) - fac_box_h
    if fac_box_y > max_fac_y:
        fac_box_y = max_fac_y

    sig_box_x = fx
    sig_box_y = fac_box_y
    sig_box_w = total_w
    sig_box_h = fac_box_h

    sig_line_y = sig_box_y + sig_box_h
    sig_pad = 12
    c.line(sig_box_x + sig_pad, sig_line_y, sig_box_x + sig_box_w - sig_pad, sig_line_y)
    c.setFont("Helvetica-BoldOblique", 9)
    c.drawCentredString(sig_box_x + sig_box_w / 2, sig_line_y - 14, "SIGNATURE / DATE")

    # Box 3 (FACULTY) - inside RIGHT cell near the divider
    box3_x = div_x + 2
    box3_y = body_top - nb - 2
    _draw_rect(c, box3_x, box3_y, nb, nb, stroke=1, fill=0)
    c.setFont("Helvetica-Bold", 10)
    c.drawCentredString(box3_x + nb / 2, box3_y + 5, "3")
    c.setFont("Helvetica-Bold", 10)
    c.drawString(box3_x + nb + 8, body_top - 16, "(FACULTY)")


    # Box 2 (centered exactly at divider intersection)
    box2_x = div_x - nb
    box2_y = split_y - nb / 2
    _fill_rect(c, box2_x, box2_y, nb, nb, WHITE)
    _draw_rect(c, box2_x, box2_y, nb, nb, stroke=1, fill=0)
    c.setFont("Helvetica-Bold", 10)
    c.drawCentredString(box2_x + nb / 2, box2_y + 5, "2")

    # ---- Footer black bar (disclaimer) ----
    _fill_rect(c, x0, y0, W, footer_h, BLACK)
    c.setFillColor(WHITE)
    footer_text = (
        "ALL RIGHTS RESERVED. Parts of this material may be reproduced provided (1) the material is not altered; "
        "(2) the use is non-commercial; (3) De La Salle University is acknowledged as source; and (4) DLSU is notified "
        "through academic.services@dlsu.edu.ph."
    )
    _fit_and_draw_text(
        c,
        footer_text,
        x0 + 6,
        y0 + 3,
        W - 12,
        footer_h - 6,
        font="Helvetica",
        max_size=6,
        min_size=5,
        leading_ratio=1.10,
        align="left",
        valign="middle",
    )
    c.setFillColor(BLACK)


def _build_pdf(rows: List[Dict[str, Any]], active_term: Dict[str, Any]) -> bytes:
    if rl_canvas is None or RL_A4 is None:
        raise HTTPException(
            status_code=500,
            detail="reportlab is not installed in the backend container. Add it to backend requirements and rebuild.",
        )

    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=RL_A4)

    for idx, r in enumerate(rows):
        if idx > 0:
            c.showPage()
        _render_one_application(c, r, active_term)

    c.save()
    return buf.getvalue()


# ---------------- routes (GET) ----------------
@router.get("/specialclass")
async def om_specialclass_get(
    action: str = Query("options", description="options | schedulePresets"),
    term_id: Optional[str] = Query(None),
    course_id: Optional[str] = Query(None),
):
    if action == "options":
        active = await _active_term()
        statuses = await _get_allowed_statuses()
        faculty = await _build_faculty_options()
        return {
            "ok": True,
            "statuses": statuses,
            "activeTerm": {
                "term_id": active.get("term_id", ""),
                "acad_year_start": active.get("acad_year_start"),
                "term_number": active.get("term_number"),
            },
            "facultyOptions": faculty,
        }

    if action == "schedulePresets":
        if not term_id:
            active = await _active_term()
            term_id = active.get("term_id")
        if not term_id or not course_id:
            return {"ok": True, "presets": []}
        presets = await _schedule_presets(term_id, course_id)
        return {"ok": True, "presets": presets}

    raise HTTPException(status_code=400, detail="Unsupported action")


# ---------------- routes (POST) ----------------
@router.post("/specialclass")
async def om_specialclass_post(
    action: str = Query("list", description="list | detail | update | bulkUpdate | exportPdf"),
    status: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    termId: Optional[str] = Query(None),
    specialId: Optional[str] = Query(None),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    active = await _active_term()
    current_term_id = termId or active.get("term_id")
    if action in {"list", "detail", "update", "bulkUpdate", "exportPdf"} and not current_term_id:
        raise HTTPException(status_code=503, detail="No active term configured.")

    if action == "list":
        match: Dict[str, Any] = {"term_id": current_term_id, "special_id": {"$exists": True}}
        if status and status.strip() and status.strip() != "All Status":
            match["status"] = status.strip()

        docs = await db[COL_SPECIAL].find(match, {"_id": 0}).sort([("submitted_at", -1)]).to_list(5000)
        if not docs:
            return {"ok": True, "rows": [], "term_id": current_term_id}

        maps = await _bulk_maps_for_rows(docs)
        shaped = [await _shape_row(r, maps) for r in docs]

        if q and q.strip():
            s = q.strip().lower()
            shaped = [
                rr for rr in shaped
                if (rr.get("student_name") or "").lower().find(s) >= 0
                or (rr.get("course_code") or "").lower().find(s) >= 0
                or (rr.get("course_title") or "").lower().find(s) >= 0
                or (rr.get("section_code") or "").lower().find(s) >= 0
            ]

        return {"ok": True, "rows": shaped, "term_id": current_term_id}

    if action == "detail":
        if not specialId:
            raise HTTPException(status_code=400, detail="specialId is required.")
        doc = await db[COL_SPECIAL].find_one({"term_id": current_term_id, "special_id": specialId}, {"_id": 0})
        if not doc:
            raise HTTPException(status_code=404, detail="Application not found.")
        maps = await _bulk_maps_for_rows([doc])
        row = await _shape_row(doc, maps)
        return {"ok": True, "row": row}

    if action == "update":
        if not specialId:
            raise HTTPException(status_code=400, detail="specialId is required.")
        if payload is None:
            raise HTTPException(status_code=400, detail="payload is required.")

        updates_set: Dict[str, Any] = {}
        updates_unset: Dict[str, Any] = {}

        # ---- always-allowed simple fields ----
        if "status" in payload:
            allowed = set(await _get_allowed_statuses())
            st = (payload.get("status") or "").strip()
            if st and allowed and st not in allowed:
                raise HTTPException(status_code=400, detail="Invalid status value.")
            updates_set["status"] = st

        if "remarks" in payload:
            updates_set["remarks"] = payload.get("remarks") or ""

        # ---- load base doc (needed for course_id when creating custom section) ----
        base_doc = await db[COL_SPECIAL].find_one(
            {"term_id": current_term_id, "special_id": specialId},
            {"_id": 0, "course_id": 1, "courseId": 1},
        )
        if not base_doc:
            raise HTTPException(status_code=404, detail="Application not found.")

        course_id_base = (base_doc.get("course_id") or base_doc.get("courseId") or "").strip()
        if not course_id_base:
            raise HTTPException(status_code=400, detail="Missing course_id on special_class record.")

        # ---- schedule binding rules ----
        # [1] If section_id is provided (existing section): store ONLY ids from that section
        # [2] If section_id is null/empty AND custom schedule provided: create docs in 3 tables and store ONLY ids

        req_section_id_raw = payload.get("section_id") if ("section_id" in payload) else None
        req_section_id = (str(req_section_id_raw).strip() if req_section_id_raw is not None else "")

        is_custom_request = (
            ("section_id" in payload and not req_section_id) and any(
                (payload.get(k) not in (None, "", [], {}))
                for k in ["section_code", "faculty_id", "day1", "begin1", "end1", "day2", "begin2", "end2"]
            )
        )

        # always remove any legacy stored schedule/faculty fields from special_class
        updates_unset.update(
            {
                "day1": "",
                "begin1": "",
                "end1": "",
                "day2": "",
                "begin2": "",
                "end2": "",
                "schedule_entries": "",
                "schedule_text": "",
                "faculty_id": "",
                "faculty_name": "",
                "section_code": "",
                "faculty_assignment_id": "",  # old field name (cleanup)
            }
        )

        if "section_id" in payload and req_section_id:
            # ✅ EXISTING SECTION path
            sid = req_section_id

            # store only IDs
            sid1, sid2 = await _schedule_ids_for_section(sid)
            fa = await _latest_faculty_assignment_for_section(sid)

            updates_set["section_id"] = sid
            updates_set["schedule_id1"] = sid1
            updates_set["schedule_id2"] = sid2
            updates_set["assignment_id"] = fa.get("assignment_id")

        elif is_custom_request:
            # ✅ CUSTOM path: create docs in sections / section_schedules / faculty_assignments
            section_code = (payload.get("section_code") or "").strip()
            fid = (payload.get("faculty_id") or "").strip()
            sched_valid = _validate_day_fields(payload)

            created = await _create_custom_section_bundle(
                term_id=current_term_id,
                course_id=course_id_base,
                section_code=section_code,
                sched=sched_valid,
                faculty_id=fid,
            )

            updates_set["section_id"] = created.get("section_id")
            updates_set["schedule_id1"] = created.get("schedule_id1")
            updates_set["schedule_id2"] = created.get("schedule_id2")
            updates_set["assignment_id"] = created.get("assignment_id")

        elif "section_id" in payload and not req_section_id:
            # clearing schedule selection with NO custom data
            updates_set["section_id"] = None
            updates_set["schedule_id1"] = None
            updates_set["schedule_id2"] = None
            updates_set["assignment_id"] = None

        if not updates_set and not updates_unset:
            return {"ok": False, "message": "Nothing to update."}

        updates_set["updated_at"] = datetime.utcnow()

        res = await db[COL_SPECIAL].update_one(
            {"term_id": current_term_id, "special_id": specialId},
            {"$set": updates_set, "$unset": updates_unset},
        )
        return {"ok": True, "matched": res.matched_count, "modified": res.modified_count}


        if not updates:
            return {"ok": False, "message": "Nothing to update."}

        updates["updated_at"] = datetime.utcnow()

        res = await db[COL_SPECIAL].update_one(
            {"term_id": current_term_id, "special_id": specialId},
            {"$set": updates},
        )
        return {"ok": True, "matched": res.matched_count, "modified": res.modified_count}

    if action == "bulkUpdate":
        if not payload or not isinstance(payload.get("special_ids"), list):
            raise HTTPException(status_code=400, detail="payload.special_ids must be an array.")
        target_status = (payload.get("status") or "").strip()
        if not target_status:
            raise HTTPException(status_code=400, detail="payload.status is required.")

        allowed = set(await _get_allowed_statuses())
        if allowed and target_status not in allowed:
            raise HTTPException(status_code=400, detail="Invalid status value.")

        res = await db[COL_SPECIAL].update_many(
            {"term_id": current_term_id, "special_id": {"$in": payload["special_ids"]}},
            {"$set": {"status": target_status, "updated_at": datetime.utcnow()}},
        )
        return {"ok": True, "matched": res.matched_count, "modified": res.modified_count, "status": target_status}

    # ✅ Export PDF: ONE ROW ONLY
    if action == "exportPdf":
        selected_ids: List[str] = []
        if payload and isinstance(payload.get("special_ids"), list):
            selected_ids = [str(x).strip() for x in payload["special_ids"] if str(x).strip()]

        if specialId:
            export_id = specialId.strip()
        else:
            if not selected_ids:
                raise HTTPException(status_code=400, detail="Please select one application row to export.")
            if len(selected_ids) != 1:
                raise HTTPException(
                    status_code=400,
                    detail="Select only ONE row per export. If multiple rows are selected, export each row separately.",
                )
            export_id = selected_ids[0]

        doc = await db[COL_SPECIAL].find_one(
            {"term_id": current_term_id, "special_id": export_id},
            {"_id": 0},
        )
        if not doc:
            raise HTTPException(status_code=404, detail="Application not found for export.")

        maps = await _bulk_maps_for_rows([doc])
        shaped = [await _shape_row(doc, maps)]
        pdf_bytes = _build_pdf(shaped, active_term=active)

        fname = f"SpecialClass_{export_id}.pdf"
        headers = {"Content-Disposition": f'attachment; filename="{fname}"'}
        return StreamingResponse(io.BytesIO(pdf_bytes), media_type="application/pdf", headers=headers)

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
