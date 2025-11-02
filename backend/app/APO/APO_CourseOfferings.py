# backend/app/APO/APO_CourseOfferings.py
from __future__ import annotations

from datetime import datetime, timedelta
from math import ceil
import re
import json
import hashlib
import secrets
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
COL_PREEN_STATS = "preenlistment_statistics"
COL_USER_ROLES = "user_roles"
COL_ROLE_ASSIGN = "role_assignments"
COL_OUTBOX = "outbox"
COL_CAMPUSES = "campuses"
COL_OVR_TOKENS = "override_tokens"
COL_OVR_AUDIT = "override_audit"
COL_PLANSTATE = "planning_state"

DEFAULT_CAP = 20

# ------------ utils ------------
def now() -> datetime:
    return datetime.utcnow()

def _ts() -> int:
    return int(datetime.utcnow().timestamp() * 1000)

def _id(prefix: str) -> str:
    return f"{prefix}{_ts()}"

def _norm_code(code: Optional[str]) -> str:
    s = (code or "").strip().upper()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"^ID\s*(\d+)$", r"ID \1", s)
    return s

def ensure_list(x: Any) -> List[Any]:
    if x is None:
        return []
    if isinstance(x, list):
        return x
    return [x]

async def current_term() -> Optional[Dict[str, Any]]:
    return await db[COL_TERMS].find_one({"is_current": True}, {"_id": 0})

# If no current term is marked, try to infer and mark one so routes still work.
async def _ensure_current_term() -> Optional[Dict[str, Any]]:
    t = await current_term()
    if t:
        return t

    sample = await db[COL_PREEN].find_one({}, {"_id": 0, "term_id": 1})
    if sample and sample.get("term_id"):
        await db[COL_TERMS].update_one({"term_id": sample["term_id"]}, {"$set": {"is_current": True}})
        t2 = await current_term()
        if t2:
            return t2

    latest = await db[COL_TERMS].find(
        {}, {"_id": 1, "term_id": 1, "acad_year_start": 1, "term_number": 1}
    ).sort([("acad_year_start", -1), ("term_number", -1)]).limit(1).to_list(1)
    if latest:
        await db[COL_TERMS].update_one({"_id": latest[0]["_id"]}, {"$set": {"is_current": True}})
        return await current_term()
    return None

def term_label(t: Optional[Dict[str, Any]]) -> str:
    if not t:
        return ""
    n = t.get("term_number")
    ays = t.get("acad_year_start")
    aye = (ays + 1) if isinstance(ays, int) else None
    return f"Term {n} · AY {ays}-{aye}" if (n and ays and aye) else (t.get("term_id") or "")

# ------------ APO scope / campus ------------
async def apo_scope(user_id: str) -> Tuple[Optional[str], Optional[str]]:
    role = await db[COL_USER_ROLES].find_one(
        {"role_type": {"$regex": "^APO$", "$options": "i"}}, {"_id": 0, "role_id": 1}
    )
    campus_id, college_id = None, None
    if role:
        ra = await db[COL_ROLE_ASSIGN].find_one(
            {"user_id": user_id, "role_id": role["role_id"]}, {"_id": 0, "scope": 1}
        )
        if ra:
            scope = ra.get("scope") or []
            if isinstance(scope, dict):
                scope = [scope]
            for s in scope:
                if isinstance(s, dict) and s.get("type") == "campus":
                    campus_id = s.get("id")
                if isinstance(s, dict) and s.get("type") == "college":
                    college_id = s.get("id")

    if not campus_id:
        u = await db[COL_USERS].find_one({"user_id": user_id}, {"_id": 0, "campus_id": 1})
        campus_id = (u or {}).get("campus_id")

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
        return "XX"
    if "manila" in n or "taft" in n:
        return "S"
    return None

DAY_NAME = {
    "M": "Monday", "MON": "Monday", "MONDAY": "Monday",
    "T": "Tuesday", "TU": "Tuesday", "TUE": "Tuesday",
    "W": "Wednesday", "WED": "Wednesday",
    "TH": "Thursday", "THU": "Thursday", "H": "Thursday", "R": "Thursday",
    "F": "Friday", "FRI": "Friday",
    "S": "Saturday", "SAT": "Saturday",
}
DOW = {"Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"}

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

def _sha1_of(obj: Any) -> str:
    b = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha1(b).hexdigest()

# ------------ Level mapping (UGS/GSM -> labels) ------------
LEVEL_LABELS = {
    "UGS": "Undergraduate",    # CSV uses UGS for Undergraduate
    "UGB": "Undergraduate",    # keep safe for legacy
    "GSM": "Graduate Studies",
}

def level_label(code: Optional[str]) -> str:
    c = (code or "").upper()
    return LEVEL_LABELS.get(c, code or "")

def level_code(label_or_code: Optional[str]) -> str:
    v = (label_or_code or "").strip()
    u = v.upper()
    if u in LEVEL_LABELS:
        return u
    if v.lower().startswith("undergrad"):
        return "UGS"
    if v.lower().startswith("graduate"):
        return "GSM"
    return v

# ------------ mappers ------------
async def map_courses(course_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    if not course_ids:
        return out
    cur = db[COL_COURSES].find(
        {"course_id": {"$in": course_ids}},
        {
            "_id": 0,
            "course_id": 1,
            "course_code": 1,
            "course_title": 1,
            "department_id": 1,
            "program_level": 1,
            "source": 1,
            "units": 1,
        },
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
            "program_level_label": level_label(c.get("program_level")),
            "source": c.get("source", "DB"),
            "units": c.get("units"),
        }
    return out

async def map_departments(dep_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    if not dep_ids:
        return out
    cur = db[COL_DEPARTMENTS].find(
        {"department_id": {"$in": dep_ids}},
        {"_id": 0, "department_id": 1, "department_name": 1, "dept_name": 1},
    )
    async for d in cur:
        out[d["department_id"]] = {
            "department_name": d.get("department_name") or d.get("dept_name") or ""
        }
    return out

def _extract_batch_number(b: Dict[str, Any]) -> Optional[int]:
    n = b.get("batch_number")
    try:
        if n is not None:
            return int(n)
    except Exception:
        pass
    code = (b.get("batch_code") or "").upper()
    m = re.search(r"(\d+)", code)
    return int(m.group(1)) if m else None

async def map_batches() -> Tuple[Dict[int, Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    by_number: Dict[int, Dict[str, Any]] = {}
    by_id: Dict[str, Dict[str, Any]] = {}
    cur = db[COL_BATCHES].find({}, {"_id": 0, "batch_id": 1, "batch_number": 1, "batch_code": 1})
    async for b in cur:
        n = _extract_batch_number(b)
        if n is not None:
            b["batch_number"] = n
        by_number[n or -1] = b
        by_id[b["batch_id"]] = b
    return by_number, by_id

async def map_programs(p_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    if not p_ids:
        return out
    cur = db[COL_PROGRAMS].find(
        {"program_id": {"$in": p_ids}},
        {"_id": 0, "program_id": 1, "program_code": 1, "department_id": 1},
    )
    async for p in cur:
        out[p["program_id"]] = {
            "program_code": p.get("program_code", ""),
            "department_id": p.get("department_id", ""),
        }
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

async def _program_latest_batch_number(program_id: str, campus_id: Optional[str]) -> Optional[int]:
    qs: Dict[str, Any] = {"program_id": program_id}
    if campus_id:
        qs["campus_id"] = campus_id
    latest = None
    cur = db[COL_BATCHES].find(qs, {"_id": 0, "batch_number": 1, "batch_code": 1})
    async for b in cur:
        n = _extract_batch_number(b)
        if n is not None:
            latest = n if latest is None else max(latest, n)
    return latest

def _year_level_name(batch_num: Optional[int], latest_num: Optional[int]) -> Optional[str]:
    if batch_num is None or latest_num is None:
        return None
    diff = latest_num - batch_num
    if diff <= 0:
        return "freshman"
    if diff == 1:
        return "sophomore"
    if diff == 2:
        return "junior"
    return "senior"

async def _program_stats_doc(term_id: str, program_id: str, _campus_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """
    Return stats for a program in a term (campus-agnostic).
    Supports fallback via program_code when only that is present in the stats collection.
    """
    proj = {"_id": 0, "freshman": 1, "sophomore": 1, "junior": 1, "senior": 1, "enrollment": 1}

    # Primary: program_id
    doc = await db[COL_PREEN_STATS].find_one({"term_id": term_id, "program_id": program_id}, proj)
    if doc:
        return doc

    # Fallback: program_code
    prog = await db[COL_PROGRAMS].find_one({"program_id": program_id}, {"_id": 0, "program_code": 1})
    pcode = (prog or {}).get("program_code")
    if pcode:
        doc = await db[COL_PREEN_STATS].find_one({"term_id": term_id, "program_code": pcode}, proj)
        if doc:
            return doc

    return None

async def _estimate_cohort_demand_for_course(term_id: str, campus_id: Optional[str], course_id: str) -> int:
    q: Dict[str, Any] = {"term_id": term_id, "course_list": course_id}
    if campus_id:
        q["campus_id"] = campus_id
    currs = [x async for x in db[COL_CURRICULUM].find(q, {"_id": 0, "program_id": 1, "batch_id": 1})]
    if not currs:
        return 0

    batch_ids = [c["batch_id"] for c in currs if c.get("batch_id")]
    by_id: Dict[str, Dict[str, Any]] = {}
    if batch_ids:
        async for b in db[COL_BATCHES].find(
            {"batch_id": {"$in": batch_ids}},
            {"_id": 0, "batch_id": 1, "batch_code": 1, "batch_number": 1},
        ):
            by_id[b["batch_id"]] = b

    grouped: Dict[str, Dict[str, List[str]]] = {}
    latest_cache: Dict[str, Optional[int]] = {}
    for c in currs:
        pid, bid = c.get("program_id"), c.get("batch_id")
        if not pid or not bid:
            continue
        if pid not in latest_cache:
            latest_cache[pid] = await _program_latest_batch_number(pid, campus_id)
        bn = _extract_batch_number(by_id.get(bid, {}))
        lvl = _year_level_name(bn, latest_cache[pid])
        if not lvl:
            continue
        grouped.setdefault(pid, {}).setdefault(lvl, []).append(bid)

    total = 0
    for pid, levels in grouped.items():
        stats = await _program_stats_doc(term_id, pid)
        if not stats:
            continue
        for lvl, bids in levels.items():
            lvl_count = int(stats.get(lvl, 0) or 0)
            denom = max(len(bids), 1)
            per_batch = (lvl_count + denom - 1) // denom
            total += per_batch * len(bids)
    return total

async def estimated_demand(term_id: str, campus_id: Optional[str], course_id: str) -> Dict[str, int]:
    preen = await preen_total_for_course(term_id, campus_id, course_id)
    cohort = await _estimate_cohort_demand_for_course(term_id, campus_id, course_id)
    plan = max(preen, cohort)
    return {"preen": preen, "cohort": cohort, "plan": plan}

# ---------- section numbering / safety ----------
async def _max_section_number(prefix: str, term_id: str, course_id: str, default_when_empty: int = 10) -> int:
    if not prefix:
        return default_when_empty
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
    return max(nums) if nums else default_when_empty

async def next_section_code(prefix: str, term_id: str, course_id: str) -> str:
    # Laguna/Canlubang uses 'XX' and should start at 22 (i.e., base=21)
    base_when_empty = 21 if (prefix or "").upper() == "XX" else 10
    start = await _max_section_number(prefix, term_id, course_id, default_when_empty=base_when_empty) + 1
    return f"{prefix}{start}" if prefix else ""

async def safe_insert_section(doc: Dict[str, Any]) -> Optional[str]:
    retries = 6
    for _ in range(retries):
        try:
            await db[COL_SECTIONS].insert_one(doc)
            return doc["section_id"]
        except DuplicateKeyError:
            prefix = re.match(r"^[A-Za-z]+", doc["section_code"]).group(0) if doc.get("section_code") else ""
            # Keep the same base rule as next_section_code()
            base_when_empty = 21 if (prefix or "").upper() == "XX" else 10
            maxn = await _max_section_number(prefix, doc["term_id"], doc["course_id"], default_when_empty=base_when_empty)
            doc["section_code"] = f"{prefix}{maxn + 1}"
            doc["section_id"] = f"SEC{int(datetime.utcnow().timestamp() * 1000)}"
    return None

# ---------- OVERRIDE infra ----------
def _make_token() -> str:
    return "ovr_" + secrets.token_urlsafe(20)

async def issue_override_token(*, user_id: str, payload: Dict[str, Any], violations: List[Dict[str, Any]], ttl_sec: int = 300) -> str:
    tok = _make_token()
    await db[COL_OVR_TOKENS].insert_one({
        "token": tok, "user_id": user_id, "violations": violations, "payload": payload,
        "expires_at": now() + timedelta(seconds=ttl_sec), "created_at": now(),
    })
    return tok

async def assert_override_token(token: str, user_id: str) -> Dict[str, Any]:
    doc = await db[COL_OVR_TOKENS].find_one({"token": token, "user_id": user_id})
    if not doc:
        raise HTTPException(status_code=409, detail="Invalid override token.")
    if doc.get("expires_at") and doc["expires_at"] < now():
        await db[COL_OVR_TOKENS].delete_one({"_id": doc["_id"]})
        raise HTTPException(status_code=409, detail="Override token expired.")
    await db[COL_OVR_TOKENS].delete_one({"_id": doc["_id"]})
    return {"violations": doc.get("violations") or [], "payload": doc.get("payload") or {}}

async def audit_override(*, user_id: str, action: str, reason: str, violations: List[Dict[str, Any]], payload: Dict[str, Any]):
    await db[COL_OVR_AUDIT].insert_one({
        "audit_id": _id("OVR-"),
        "user_id": user_id,
        "action": action,
        "reason": (reason or "").strip(),
        "violations": violations,
        "payload": payload,
        "created_at": now(),
    })

# ---------- SOFT/HARD validation ----------
async def validate_hard_errors(action: str, payload: Dict[str, Any], term_id: str) -> List[Dict[str, str]]:
    errs: List[Dict[str, str]] = []
    def err(code: str, msg: str):
        errs.append({"code": code, "message": msg})

    if action in {"addRow", "editRow"}:
        course_id = (payload.get("course_id") or payload.get("links", {}).get("course_id") or "").strip()
        if not course_id:
            err("COURSE_REQUIRED", "course_id is required.")
        else:
            if not await db[COL_COURSES].find_one({"course_id": course_id}):
                err("COURSE_NOT_FOUND", "Invalid course_id.")

    if action in {"addRow"}:
        batch_id = (payload.get("batch_id") or "").strip()
        if not batch_id or not await db[COL_BATCHES].find_one({"batch_id": batch_id}):
            err("BATCH_NOT_FOUND", "Invalid batch_id.")

    if action in {"editRow", "deleteRow"}:
        section_id = (payload.get("section_id") or "").strip()
        if not section_id:
            err("SECTION_REQUIRED", "section_id is required.")
        else:
            if not await db[COL_SECTIONS].find_one({"section_id": section_id, "term_id": term_id}):
                err("SECTION_NOT_FOUND", "Section not found for current term.")

    if "enrollment_cap" in payload:
        cap = payload.get("enrollment_cap")
        if cap not in (None, ""):
            try:
                cap = int(cap)
            except Exception:
                err("CAPACITY_INVALID", "enrollment_cap must be a number.")
            else:
                if cap < 0:
                    err("CAPACITY_NEGATIVE", "enrollment_cap cannot be negative.")

    if action in {"addRow", "editRow"} and payload.get("section_code"):
        course_id = (payload.get("course_id") or payload.get("links", {}).get("course_id") or "").strip()
        q = {"term_id": term_id, "course_id": course_id, "section_code": payload["section_code"].strip()}
        if action == "editRow":
            q["section_id"] = {"$ne": payload.get("section_id")}
        if await db[COL_SECTIONS].find_one(q):
            err("SECTION_CODE_DUP", "Section code already in use for this course and term.")

    return errs

async def validate_soft_conflicts(
    *, action: str, payload: Dict[str, Any], campus_prefix: str, term_id: str, campus_id: Optional[str],
) -> List[Dict[str, Any]]:
    conf: List[Dict[str, Any]] = []
    def warn(code: str, msg: str, data: Optional[Dict[str, Any]] = None):
        item = {"code": code, "level": "warning", "message": msg}
        if data:
            item["data"] = data
        conf.append(item)

    sec_code = (payload.get("section_code") or "").strip()
    if sec_code:
        if campus_prefix and not sec_code.upper().startswith(campus_prefix):
            warn("PREFIX_MISMATCH", f"Section code doesn't start with '{campus_prefix}'.", {"section_code": sec_code})
        if not re.search(r"\d", sec_code):
            warn("CODE_WITHOUT_NUMBER", "Section code has no numeric part (e.g., S11 / XX22).", {"section_code": sec_code})

    s1 = (payload.get("slot1") or {})
    s2 = (payload.get("slot2") or {})
    if (s1.get("room_id") in (None, "")) and (s2.get("room_id") in (None, "")):
        warn("NO_ROOM_SET", "No room selected yet (TBA).")

    course_id = (payload.get("course_id") or payload.get("links", {}).get("course_id") or "").strip()
    if course_id:
        sec_q: Dict[str, Any] = {"term_id": term_id, "course_id": course_id}
        if campus_prefix:
            sec_q["section_code"] = {"$regex": f"^{campus_prefix}", "$options": "i"}
        planned_cap = 0
        async for s in db[COL_SECTIONS].find(sec_q, {"_id": 0, "enrollment_cap": 1}):
            planned_cap += int(s.get("enrollment_cap") or DEFAULT_CAP)

        cap_delta = 0
        if action == "addRow":
            cap_delta += int(payload.get("enrollment_cap") or DEFAULT_CAP)
        if action == "editRow" and "enrollment_cap" in payload and payload.get("enrollment_cap") not in (None, ""):
            old = await db[COL_SECTIONS].find_one({"section_id": payload.get("section_id")}, {"_id": 0, "enrollment_cap": 1})
            old_cap = int((old or {}).get("enrollment_cap") or DEFAULT_CAP)
            new_cap = int(payload.get("enrollment_cap"))
            cap_delta += (new_cap - old_cap)
        if action == "deleteRow":
            old = await db[COL_SECTIONS].find_one({"section_id": payload.get("section_id")}, {"_id": 0, "enrollment_cap": 1})
            if old:
                cap_delta -= int(old.get("enrollment_cap") or DEFAULT_CAP)

        est = await estimated_demand(term_id, campus_id, course_id)
        total_intent = est["plan"]

        if not payload.get("auto_approve"):
            after_cap = planned_cap + cap_delta
            if after_cap < total_intent:
                warn(
                    "SEAT_DEFICIT",
                    f"Capacity below demand by {total_intent - after_cap}",
                    {"planned_after": after_cap, "demand_plan": total_intent, "preen": est["preen"], "cohort": est["cohort"]},
                )

    if action == "deleteRow" and payload.get("section_id"):
        sid = payload["section_id"]
        if await db[COL_FAC_ASSIGN].find_one({"section_id": sid, "is_archived": {"$ne": True}}):
            warn("HAS_FACULTY_ASSIGN", "This section has faculty assignment; deleting will archive it.")
        if await db[COL_SCHEDS].find_one({"section_id": sid}):
            warn("HAS_SCHEDULES", "This section has schedules; deleting will remove them.")

    return conf

# ---------- deterministic seating / helpers ----------
def _sort_sections_by_number(sections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    def num(s):
        code = (s.get("section_code") or "").upper()
        d = "".join(ch for ch in code if ch.isdigit())
        try:
            return int(d)
        except Exception:
            return 0
    return sorted(sections, key=num)

def _assign_blocks_to_sections(
    block_keys: List[Tuple[str, str, str, int]],  # (batch_id, program_id, label, batch_number)
    sections: List[Dict[str, Any]]
) -> Dict[Tuple[str, str], Optional[Dict[str, Any]]]:
    by_bn: Dict[int, List[Dict[str, Any]]] = {}
    legacy: List[Dict[str, Any]] = []
    for s in _sort_sections_by_number(sections):
        bn = s.get("batch_number")
        if isinstance(bn, int):
            by_bn.setdefault(bn, []).append(s)
        else:
            legacy.append(s)

    seating: Dict[Tuple[str, str], Optional[Dict[str, Any]]] = {}
    used: set = set()
    for (bid, pid, _label, bn) in block_keys:
        match = None
        if isinstance(bn, int) and bn in by_bn:
            for s in by_bn[bn]:
                if s["section_id"] not in used:
                    match = s
                    break
        if not match and legacy:
            while legacy and legacy[0]["section_id"] in used:
                legacy.pop(0)
            if legacy:
                match = legacy.pop(0)
        seating[(bid, pid)] = match
        if match:
            used.add(match["section_id"])
    return seating

# New: round-robin distribution to support multiple blocks per owner
def _unique_owners_in_order(keys: List[Tuple[str, str, str, int]]) -> List[Tuple[str, str, int]]:
    seen = set()
    out: List[Tuple[str, str, int]] = []
    for (bid, pid, _label, bn) in keys:
        k = (bid, pid)
        if k not in seen:
            seen.add(k)
            out.append((bid, pid, int(bn) if isinstance(bn, int) else 0))
    return out

def _distribute_sections_round_robin(
    sections: List[Dict[str, Any]],
    owners: List[Tuple[str, str, int]]
) -> Dict[Tuple[str, str], List[Dict[str, Any]]]:
    secs = _sort_sections_by_number(sections)
    if not owners:
        return {}
    n = len(owners)
    alloc: Dict[Tuple[str, str], List[Dict[str, Any]]] = {(bid, pid): [] for (bid, pid, _bn) in owners}
    for idx, s in enumerate(secs):
        (bid, pid, _bn) = owners[idx % n]
        alloc[(bid, pid)].append(s)
    return alloc

# ---------- ensure sections by demand ----------
async def ensure_sections_from_demand(
    *, term_id: str, campus_id: str, campus_prefix: str, course_id: str, base_per_program: int, capacity: int = DEFAULT_CAP
) -> None:
    q: Dict[str, Any] = {"term_id": term_id, "course_id": course_id}
    if campus_prefix:
        q["section_code"] = {"$regex": f"^{campus_prefix}", "$options": "i"}
    existing = await db[COL_SECTIONS].count_documents(q)
    if existing < base_per_program:
        to_make = base_per_program - existing
        for _ in range(to_make):
            code = await next_section_code(campus_prefix, term_id, course_id)
            doc = {
                "section_id": _id("SEC"),
                "section_code": code,
                "course_id": course_id,
                "term_id": term_id,
                "enrollment_cap": capacity,
                "remarks": "",
                "created_at": now(), "updated_at": now(),
            }
            await safe_insert_section(doc)
        existing += to_make

    est = await estimated_demand(term_id, campus_id, course_id)
    total = est["plan"]
    needed = max(base_per_program, ceil((total or 0) / (capacity or DEFAULT_CAP))) or 1
    if existing < needed:
        for _ in range(needed - existing):
            code = await next_section_code(campus_prefix, term_id, course_id)
            doc = {
                "section_id": _id("SEC"),
                "section_code": code,
                "course_id": course_id,
                "term_id": term_id,
                "enrollment_cap": capacity,
                "remarks": "",
                "created_at": now(), "updated_at": now(),
            }
            await safe_insert_section(doc)

async def _create_sections(
    *, term_id: str, campus_prefix: str, course_id: str, count: int, capacity: int = DEFAULT_CAP
) -> int:
    """Create exactly `count` sections for this course (campus-scoped by code prefix)."""
    made = 0
    for _ in range(max(0, int(count))):
        code = await next_section_code(campus_prefix, term_id, course_id)
        doc = {
            "section_id": _id("SEC"),
            "section_code": code,
            "course_id": course_id,
            "term_id": term_id,
            "enrollment_cap": capacity,
            "remarks": "",
            "created_at": now(),
            "updated_at": now(),
        }
        if await safe_insert_section(doc):
            made += 1
    return made

async def reduce_sections_if_excess(*, term_id: str, campus_prefix: str, course_id: str, target_count: int) -> int:
    q: Dict[str, Any] = {"term_id": term_id, "course_id": course_id}
    if campus_prefix:
        q["section_code"] = {"$regex": f"^{campus_prefix}", "$options": "i"}

    secs = [s async for s in db[COL_SECTIONS].find(q, {"_id": 0, "section_id": 1, "section_code": 1})]
    secs = sorted(
        secs,
        key=lambda s: int("".join(ch for ch in (s.get("section_code", "")) if ch.isdigit()) or "0"),
        reverse=True,
    )
    cur_count = len(secs)
    if cur_count <= target_count:
        return 0

    removable: List[Dict[str, Any]] = []
    for s in secs:
        sid = s["section_id"]
        has_sched = await db[COL_SCHEDS].find_one({"section_id": sid}) is not None
        has_fac = await db[COL_FAC_ASSIGN].find_one({"section_id": sid, "is_archived": {"$ne": True}}) is not None
        if not has_sched and not has_fac:
            removable.append(s)

    to_delete = min(cur_count - target_count, len(removable))
    deleted = 0
    for s in removable[:to_delete]:
        sid = s["section_id"]
        await db[COL_SECTIONS].delete_one({"section_id": sid})
        await db[COL_SCHEDS].delete_many({"section_id": sid})
        await db[COL_FAC_ASSIGN].update_many({"section_id": sid}, {"$set": {"is_archived": True, "updated_at": now()}})
        deleted += 1
    return deleted

# ---------- planning snapshots & diffs ----------
async def _preen_snapshot(term_id: str, campus_id: str) -> Dict[str, int]:
    cond = {"term_id": term_id, "is_archived": {"$ne": True}}
    if await db[COL_PREEN].count_documents({**cond, "campus_id": campus_id}) > 0:
        cond["campus_id"] = campus_id
    out: Dict[str, int] = {}
    async for d in db[COL_PREEN].find(cond, {"_id": 0, "course_id": 1, "preenlistment_count": 1, "count": 1}):
        cid = d.get("course_id") or ""
        out[cid] = out.get(cid, 0) + int(d.get("preenlistment_count") or d.get("count") or 0)
    return out

async def _cohort_snapshot(term_id: str, campus_id: str) -> Dict[str, Dict[str, int]]:
    cur = db[COL_CURRICULUM].find({"term_id": term_id, "campus_id": campus_id}, {"_id": 0, "program_id": 1})
    rows = [x async for x in cur]
    pids = sorted(list({r["program_id"] for r in rows if r.get("program_id")}))
    out: Dict[str, Dict[str, int]] = {}
    for pid in pids:
        stats = await _program_stats_doc(term_id, pid) or {}
        out[pid] = {
            "freshman": int(stats.get("freshman") or 0),
            "sophomore": int(stats.get("sophomore") or 0),
            "junior": int(stats.get("junior") or 0),
            "senior": int(stats.get("senior") or 0),
        }
    return out

async def _planned_capacity_by_course(term_id: str, campus_prefix: str, course_ids: List[str]) -> Dict[str, int]:
    out: Dict[str, int] = {}
    for cid in course_ids:
        sec_q: Dict[str, Any] = {"term_id": term_id, "course_id": cid}
        if campus_prefix:
            sec_q["section_code"] = {"$regex": f"^{campus_prefix}", "$options": "i"}
        total = 0
        async for s in db[COL_SECTIONS].find(sec_q, {"_id": 0, "enrollment_cap": 1}):
            total += int(s.get("enrollment_cap") or DEFAULT_CAP)
        out[cid] = total
    return out

async def _section_count(term_id: str, campus_prefix: str, course_id: str) -> int:
    q: Dict[str, Any] = {"term_id": term_id, "course_id": course_id}
    if campus_prefix:
        q["section_code"] = {"$regex": f"^{campus_prefix}", "$options": "i"}
    return await db[COL_SECTIONS].count_documents(q)

async def _pending_changes(
    *, term_id: str, campus_id: str, campus_prefix: str
) -> Tuple[bool, List[Dict[str, Any]], str, str]:
    has_preen = await db[COL_PREEN].count_documents({"term_id": term_id, "is_archived": {"$ne": True}}) > 0
    has_stats = await db[COL_PREEN_STATS].count_documents({"term_id": term_id}) > 0
    needs_import = not (has_preen and has_stats)

    preen_map = await _preen_snapshot(term_id, campus_id)
    cohort_map = await _cohort_snapshot(term_id, campus_id)
    preen_hash = _sha1_of(preen_map)
    cohort_hash = _sha1_of(cohort_map)

    if needs_import:
        return (True, [], preen_hash, cohort_hash)

    currs = [x async for x in db[COL_CURRICULUM].find(
        {"term_id": term_id, "campus_id": campus_id},
        {"_id": 0, "program_id": 1, "batch_id": 1, "course_list": 1}
    )]
    course_ids_in_curr = set()
    for c in currs:
        for cid in ensure_list(c.get("course_list")):
            if cid:
                course_ids_in_curr.add(cid)

    changes: List[Dict[str, Any]] = []
    for cid, cnt in preen_map.items():
        if cid and cnt > 0 and cid not in course_ids_in_curr:
            sample = await db[COL_PREEN].find_one({"term_id": term_id, "course_id": cid, "campus_id": campus_id}) \
                     or await db[COL_PREEN].find_one({"term_id": term_id, "course_id": cid})
            target = None
            if sample and sample.get("program_id") and sample.get("batch_id"):
                target = {"program_id": sample["program_id"], "batch_id": sample["batch_id"]}
            changes.append({
                "type": "add_course_to_curriculum",
                "course_id": cid,
                "count": cnt,
                "target": target,
            })

    view_course_ids = sorted(list(course_ids_in_curr))
    demand_by_course: Dict[str, int] = {}
    for cid in view_course_ids:
        est = await estimated_demand(term_id, campus_id, cid)
        demand_by_course[cid] = est["plan"]
    cap_by_course = await _planned_capacity_by_course(term_id, campus_prefix, view_course_ids)

    # Decide by SECTION COUNT
    for cid in view_course_ids:
        plan = int(demand_by_course.get(cid) or 0)
        existing = await _section_count(term_id, campus_prefix, cid)
        need = max(1, ceil((plan or 0) / (DEFAULT_CAP or 20)))
        if existing < need:
            changes.append({"type": "sections_increase", "course_id": cid, "by_sections": need - existing})
        elif existing > need:
            changes.append({"type": "sections_decrease", "course_id": cid, "by_sections": existing - need})

    return (False, changes, preen_hash, cohort_hash)

async def _planning_flags(term_id: str, campus_id: str, campus_prefix: str):
    """
    Returns (needs_import, approval_required, pending_changes, preen_hash, cohort_hash, plan_state_doc)
    """
    needs_import, pending, preen_hash, cohort_hash = await _pending_changes(
        term_id=term_id, campus_id=campus_id, campus_prefix=campus_prefix
    )

    plan_state = await db[COL_PLANSTATE].find_one({"term_id": term_id, "campus_id": campus_id}) or {}
    approved_flag = bool(plan_state.get("approved"))
    last_preen = plan_state.get("last_preen_hash")
    last_cohort = plan_state.get("last_cohort_hash")

    approval_required = (not needs_import) and (
        bool(pending)
        or (approved_flag is False)
        or (preen_hash != last_preen)
        or (cohort_hash != last_cohort)
    )
    return needs_import, approval_required, pending, preen_hash, cohort_hash, plan_state

# ---------- GET ----------
@router.get("/courseofferings")
async def get_course_offerings(
    userId: str = Query(..., min_length=3),
    level: Optional[str] = Query(None),
    department_id: Optional[str] = Query(None),
    batch_id: Optional[str] = Query(None),
    program_id: Optional[str] = Query(None),
    view: Optional[Literal["curriculum", "offerings"]] = Query("offerings"),
):
    # Ensure a current term exists
    t = await current_term() or await _ensure_current_term()
    term_id = (t or {}).get("term_id")
    if not term_id:
        # graceful empty reply
        return {
            "campus": {"campus_id": "", "campus_name": ""},
            "term_id": "", "term_label": "",
            "filters": {"levels": [], "departments": [], "ids": [], "programs": []},
            "rows": [], "course_options_by_group": {}, "room_options": [],
            "planning": {"needs_import": True, "approval_required": False}
        }

    campus_id, _ = await apo_scope(userId)
    if not campus_id:
        raise HTTPException(status_code=400, detail="Unable to resolve APO campus from role_assignments.")
    campus = await campus_meta(campus_id)
    prefix = campus_section_prefix(campus.get("campus_name", "")) or ""

    # ---- Curriculum View ----
    if view == "curriculum":
        curr = [x async for x in db[COL_CURRICULUM].find(
            {"term_id": term_id, "campus_id": campus_id},
            {"_id": 0, "curriculum_id": 1, "program_id": 1, "batch_id": 1, "term_id": 1, "course_list": 1}
        )]
        batch_by_number, batch_by_id = await map_batches()
        prog_ids = sorted(list({c["program_id"] for c in curr if c.get("program_id")}))
        prog_map = await map_programs(prog_ids)
        dep_ids = sorted(list({
            (prog_map.get(p) or {}).get("department_id","")
            for p in prog_ids if (prog_map.get(p) or {}).get("department_id")
        }))
        dep_map = await map_departments(dep_ids)

        all_cids = sorted(list({cid for r in curr for cid in ensure_list(r.get("course_list"))}))
        cinfo = await map_courses(all_cids)

        items: List[Dict[str, Any]] = []
        for r in curr:
            pid = r.get("program_id", ""); bid = r.get("batch_id", "")
            b = batch_by_id.get(bid, {}); p = prog_map.get(pid, {})
            dep_id = p.get("department_id", "")
            courses: List[Dict[str, Any]] = []
            for cid in ensure_list(r.get("course_list")):
                ci = cinfo.get(cid, {})
                courses.append({
                    "course_id": cid,
                    "code": ci.get("course_code",""),
                    "title": ci.get("course_title",""),
                    "units": ci.get("units"),
                    "department_id": ci.get("department_id",""),
                    "department_name": dep_map.get(ci.get("department_id",""),{}).get("department_name",""),
                    "program_level": ci.get("program_level_label",""),
                    "program_level_code": ci.get("program_level",""),
                    "source": ci.get("source","DB")
                })
            items.append({
                "program_id": pid, "program_code": p.get("program_code",""),
                "department_id": dep_id, "department_name": dep_map.get(dep_id,{}).get("department_name",""),
                "batch_id": bid, "batch_code": _norm_code(b.get("batch_code")),
                "courses": courses,
            })

        # Course picker: only courses from the Program’s department
        by_dep: Dict[str, List[Dict[str, Any]]] = {}
        async for cc in db[COL_COURSES].find(
            {"department_id": {"$in": dep_ids}},
            {"_id":0,"course_id":1,"course_code":1,"course_title":1,"department_id":1,"program_level":1,"units":1}
        ):
            code = cc.get("course_code")
            if isinstance(code, list):
                code = code[0] if code else ""
            by_dep.setdefault(cc["department_id"], []).append({
                "course_id": cc["course_id"],
                "course_code": code or "",
                "course_title": cc.get("course_title",""),
                "department_id": cc.get("department_id",""),
                "program_level": level_label(cc.get("program_level")),
                "program_level_code": cc.get("program_level"),
                "units": cc.get("units"),
            })
        course_options_by_program: Dict[str, List[Dict[str, Any]]] = {}
        for pid, p in prog_map.items():
            dep_id = p.get("department_id","")
            opts = sorted(by_dep.get(dep_id, []), key=lambda x: x["course_code"])
            course_options_by_program[pid] = opts

        departments = [{"department_id": d, "department_name": dep_map.get(d,{}).get("department_name","")} for d in dep_ids]
        return {
            "campus": campus,
            "term_id": term_id,
            "term_label": term_label(t),
            "items": items,
            "course_options_by_program": course_options_by_program,
            "departments": departments
        }

    # ---- Offerings View ----
    room_opts: List[Dict[str, str]] = [
        {"room_id": "", "room_number": "— TBA —"},
        {"room_id": "ONLINE", "room_number": "ONLINE"},
    ]
    async for r in db[COL_ROOMS].find({"campus_id": campus_id}, {"_id": 0, "room_id": 1, "room_number": 1}):
        room_opts.append({"room_id": r["room_id"], "room_number": r.get("room_number", r["room_id"])})

    # Filtered view query (applies UI filters)
    q_view: Dict[str, Any] = {"term_id": term_id, "campus_id": campus_id}
    if batch_id:
        q_view["batch_id"] = batch_id
    if program_id:
        q_view["program_id"] = program_id

    curricula = [x async for x in db[COL_CURRICULUM].find(
        q_view,
        {"_id": 0, "curriculum_id": 1, "program_id": 1, "batch_id": 1, "term_id": 1, "course_list": 1}
    )]

    # ---- Stable Program No. computation: use ALL campus curricula (no filters)
    curricula_all_for_no = [x async for x in db[COL_CURRICULUM].find(
        {"term_id": term_id, "campus_id": campus_id},
        {"_id": 0, "program_id": 1, "batch_id": 1}
    )]

    batch_by_number, batch_by_id = await map_batches()

    # Map programs for both the filtered set (data) and all-for-numbering (labels)
    prog_ids_view = list({c["program_id"] for c in curricula if c.get("program_id")})
    prog_ids_for_no = list({c["program_id"] for c in curricula_all_for_no if c.get("program_id")})
    prog_map_view = await map_programs(prog_ids_view)
    prog_map_all = await map_programs(prog_ids_for_no)

    all_course_ids = sorted(list({cid for c in curricula for cid in ensure_list(c.get("course_list"))}))
    c_map_all = await map_courses(all_course_ids)
    dep_ids_all = sorted(list({c_map_all[cid]["department_id"] for cid in c_map_all if c_map_all[cid].get("department_id")}))
    dep_map = await map_departments(dep_ids_all)

    # ----- level/dept filters use FRIENDLY level labels -----
    def level_ok(cid: str) -> bool:
        return (not level) or (c_map_all.get(cid, {}).get("program_level_label") == level)

    def dept_ok(cid: str) -> bool:
        return (not department_id) or (c_map_all.get(cid, {}).get("department_id") == department_id)

    level_set = {c_map_all[cid].get("program_level_label")
                 for cid in c_map_all if c_map_all[cid].get("program_level_label")}
    levels = [l for l in ["Undergraduate", "Graduate Studies"] if l in level_set]  # stable order

    dep_opts = [{"department_id": d, "department_name": dep_map.get(d, {}).get("department_name", "")} for d in dep_ids_all]

    id_opts_unsorted: List[Dict[str, Any]] = []
    seen_batch_ids = set()
    for c in curricula:
        b = batch_by_id.get(c.get("batch_id") or "")
        if not b:
            continue
        bid = b["batch_id"]
        if bid in seen_batch_ids:
            continue
        seen_batch_ids.add(bid)
        id_opts_unsorted.append({
            "batch_id": bid,
            "batch_code": _norm_code(b.get("batch_code")),
            "batch_number": int(b.get("batch_number") or 0),
        })
    id_opts_unsorted.sort(key=lambda x: (-x["batch_number"], x["batch_code"]))
    id_opts = [{"batch_id": x["batch_id"], "batch_code": x["batch_code"]} for x in id_opts_unsorted]

    prog_opts, seen_prog = [], set()
    for c in curricula:
        pid = c.get("program_id")
        if not pid or pid in seen_prog:
            continue
        seen_prog.add(pid)
        prog_opts.append({"program_id": pid, "program_code": (prog_map_view.get(pid, {}) or {}).get("program_code", "")})

    allowed_course_ids = {cid for cid in all_course_ids if level_ok(cid) and dept_ok(cid)}

    options_by_group: Dict[str, List[Dict[str, str]]] = {}
    for cur in curricula:
        key = f'{cur.get("batch_id","")}|{cur.get("program_id","")}'
        opts: List[Dict[str, str]] = []
        for cid in ensure_list(cur.get("course_list")):
            if cid not in allowed_course_ids:
                continue
            cm = c_map_all.get(cid, {})
            if not cm:
                continue
            opts.append({"course_id": cid, "course_code": cm.get("course_code", ""), "course_title": cm.get("course_title", "")})
        seen, uniq = set(), []
        for o in opts:
            if o["course_id"] in seen:
                continue
            seen.add(o["course_id"]); uniq.append(o)
        options_by_group[key] = sorted(uniq, key=lambda x: x["course_code"])

    needs_import, approval_required, pending, preen_hash, cohort_hash, plan_state = await _planning_flags(
        term_id=term_id, campus_id=campus_id, campus_prefix=prefix
    )

    campus_sec_by_course: Dict[str, List[Dict[str, Any]]] = {}
    planned_capacity_by_course: Dict[str, int] = {}
    for cid in allowed_course_ids:
        sec_q: Dict[str, Any] = {"term_id": term_id, "course_id": cid}
        if prefix:
            sec_q["section_code"] = {"$regex": f"^{prefix}", "$options": "i"}
        secs = [s async for s in db[COL_SECTIONS].find(
            sec_q, {"_id": 0, "section_id": 1, "section_code": 1, "enrollment_cap": 1, "remarks": 1, "batch_number": 1}
        )]
        campus_sec_by_course[cid] = secs
        planned_capacity_by_course[cid] = sum(int(s.get("enrollment_cap") or DEFAULT_CAP) for s in secs)

    def _bn(bid: Optional[str]) -> int:
        b = batch_by_id.get(bid or "", {})
        try:
            return int(b.get("batch_number") or 0)
        except Exception:
            return 0

    def _pc_view(pid: Optional[str]) -> str:
        return (prog_map_view.get(pid or "", {}) or {}).get("program_code", "") or ""

    # ---- Build a STABLE Program No. map from ALL campus curricula ----
    curricula_all_sorted = sorted(
        curricula_all_for_no,
        key=lambda x: (-_bn(x.get("batch_id")), (prog_map_all.get(x.get("program_id",""), {}) or {}).get("program_code","") or "")
    )
    prog_no_label_map: Dict[Tuple[str, str], str] = {}
    per_batch_seq: Dict[str, int] = {}
    for cur in curricula_all_sorted:
        bid = cur.get("batch_id") or ""
        pid = cur.get("program_id") or ""
        pc = (prog_map_all.get(pid, {}) or {}).get("program_code", "") or "PROG"
        per_batch_seq[bid] = per_batch_seq.get(bid, 0) + 1
        prog_no_label_map[(bid, pid)] = f"{pc}-{per_batch_seq[bid]}"

    # --- Continue with the filtered set for rows
    curricula_sorted = sorted(curricula, key=lambda x: (-_bn(x.get("batch_id")), _pc_view(x.get("program_id"))))

    # Build owner keys per course → then round-robin distribute sections among owners
    block_keys_by_course: Dict[str, List[Tuple[str, str, str, int]]] = {}
    for cur in curricula_sorted:
        bid = cur.get("batch_id", "")
        pid = cur.get("program_id", "")
        binfo = batch_by_id.get(bid or "", {})
        bn = int(binfo.get("batch_number") or 0)
        label = prog_no_label_map.get((bid, pid), "PROG-?")
        for course_id in ensure_list(cur.get("course_list")):
            if course_id in allowed_course_ids:
                block_keys_by_course.setdefault(course_id, []).append((bid, pid, label, bn))

    distribution_by_course: Dict[str, Dict[Tuple[str, str], List[Dict[str, Any]]]] = {}
    for cid in allowed_course_ids:
        owners = _unique_owners_in_order(block_keys_by_course.get(cid, []))
        distribution_by_course[cid] = _distribute_sections_round_robin(campus_sec_by_course.get(cid, []), owners)

    rows: List[Dict[str, Any]] = []

    for cur in curricula_sorted:
        bid = cur.get("batch_id", "")
        pid = cur.get("program_id", "")
        binfo = batch_by_id.get(bid or "", {})
        batch_num = int(binfo.get("batch_number") or 0)
        prog_no_base = prog_no_label_map.get((bid, pid), "PROG-?")  # e.g., "BSCS (CBL)-1"

        for course_id in ensure_list(cur.get("course_list")):
            if course_id not in allowed_course_ids:
                continue
            cinfo = c_map_all.get(course_id, {})
            dep_name = dep_map.get(cinfo.get("department_id", ""), {}).get("department_name", "")

            est = await estimated_demand(term_id, campus_id, course_id)
            total_intent = est["plan"]
            preen_total = est["preen"]
            cohort_est = est["cohort"]
            planned_cap = planned_capacity_by_course.get(course_id, 0)
            existing_sections = len(campus_sec_by_course.get(course_id, []))
            suggest_total_sections = ceil((total_intent or 0) / (DEFAULT_CAP or 20)) or 0
            suggest_additional = max(0, suggest_total_sections - existing_sections)
            deficit = max(0, (total_intent or 0) - planned_cap)

            async def slot_payload_from_schedules(sid: str):
                scheds = [x async for x in db[COL_SCHEDS].find(
                    {"section_id": sid},
                    {"_id": 0, "schedule_id": 1, "section_id": 1, "day": 1, "start_time": 1, "end_time": 1, "room_id": 1}
                )]
                picked = sorted(scheds, key=lambda s: (normalize_day(s.get("day")), int(str(s.get("start_time") or "0"))))[:2]
                rids = list({sc.get("room_id") for sc in scheds if sc.get("room_id")})
                rmap: Dict[str, Dict[str, Any]] = {}
                if rids:
                    async for r in db[COL_ROOMS].find({"room_id": {"$in": rids}}, {"_id": 0, "room_id": 1, "room_number": 1}):
                        rmap[r["room_id"]] = r
                def slot_payload(x: Optional[Dict[str, Any]]):
                    if not x:
                        return None
                    rid = (x.get("room_id") or "").strip()
                    room_number = (rmap.get(rid) or {}).get("room_number", "")
                    if not room_number and rid in {"ONLINE", ""}:
                        room_number = "ONLINE" if rid == "ONLINE" else "— TBA —"
                    return {
                        "schedule_id": x.get("schedule_id", ""),
                        "day": normalize_day(x.get("day")),
                        "start_time": x.get("start_time", ""),
                        "end_time": x.get("end_time", ""),
                        "room_id": rid,
                        "room_number": room_number,
                    }
                return (slot_payload(picked[0]) if len(picked) >= 1 else None,
                        slot_payload(picked[1]) if len(picked) >= 2 else None)

            async def first_faculty_name_for_section(term_id: str, section_id: str) -> Tuple[str, Optional[str]]:
                fa = await db[COL_FAC_ASSIGN].find_one(
                    {"term_id": term_id, "section_id": section_id, "is_archived": {"$ne": True}},
                    {"_id": 0, "user_id": 1, "faculty_id": 1}
                )
                if not fa:
                    return ("UNASSIGNED", None)
                uid = (fa.get("user_id") or "").strip()
                if uid:
                    u = await db[COL_USERS].find_one(
                        {"user_id": uid}, {"_id": 0, "first_name": 1, "last_name": 1, "middle_name": 1}
                    )
                    if u:
                        return (caps_name(u) or f"USER:{uid}", uid)
                    return (f"USER:{uid}", uid)
                fid = (fa.get("faculty_id") or "").strip()
                if fid:
                    fp = await db[COL_FAC_PROFILES].find_one(
                        {"faculty_id": fid}, {"_id": 0, "first_name": 1, "last_name": 1, "middle_name": 1, "user_id": 1}
                    )
                    if fp:
                        linked = (fp.get("user_id") or "").strip() or fid
                        return (caps_name(fp) or f"FACULTY:{fid}", linked)
                    return (f"FACULTY:{fid}", fid)
                return ("UNASSIGNED", None)

            course_payload = {
                "course_id": course_id,
                "course_code": cinfo.get("course_code",""),
                "course_title": cinfo.get("course_title",""),
                "program_level": cinfo.get("program_level",""),
                "program_level_label": cinfo.get("program_level_label",""),
                "department_id": cinfo.get("department_id",""),
                "department_name": dep_name
            }

            my_sections = distribution_by_course.get(course_id, {}).get((bid, pid), [])

            def sizing_payload():
                return {
                    "preenlistment_total": preen_total or 0,
                    "cohort_estimate": cohort_est or 0,
                    "planning_demand": total_intent or 0,
                    "planned_capacity": planned_cap,
                    "existing_sections": existing_sections,
                    "suggest_additional": suggest_additional,
                    "deficit": deficit,
                }

            if not my_sections:
                # No section yet: placeholder row (allows inline add) -> Block 1
                rows.append({
                    "program_no": f"{prog_no_base}-1",
                    "batch": {"batch_id": binfo.get("batch_id", ""), "batch_code": _norm_code(binfo.get("batch_code")), "batch_number": batch_num or None},
                    "program": {"program_id": pid, "program_code": (prog_map_view.get(pid, {}) or {}).get("program_code", "")},
                    "course": course_payload,
                    "section": {"section_id": "", "section_code": "", "enrollment_cap": None, "remarks": ""},
                    "faculty": {"faculty_id": None, "user_id": None, "faculty_name": "UNASSIGNED"},
                    "slot1": None, "slot2": None,
                    "links": {"curriculum_id": cur.get("curriculum_id"), "term_id": term_id, "course_id": course_id, "batch_id": binfo.get("batch_id", ""), "program_id": pid},
                    "sizing": sizing_payload(),
                })
            else:
                # Emit each assigned section as its own row, with Block numbering
                for idx, s in enumerate(my_sections, start=1):
                    sid = s["section_id"]
                    slot1, slot2 = await slot_payload_from_schedules(sid)
                    faculty_name, faculty_id = await first_faculty_name_for_section(term_id, sid)
                    rows.append({
                        "program_no": f"{prog_no_base}-{idx}",
                        "block_index": idx,                         # <-- add this
                        "batch": {"batch_id": binfo.get("batch_id", ""), "batch_code": _norm_code(binfo.get("batch_code")), "batch_number": batch_num or None},
                        "program": {"program_id": pid, "program_code": (prog_map_view.get(pid, {}) or {}).get("program_code", "")},
                        "course": course_payload,
                        "section": {
                            "section_id": sid,
                            "section_code": s.get("section_code", ""),
                            "enrollment_cap": s.get("enrollment_cap"),
                            "remarks": s.get("remarks", "")
                        },
                        "faculty": {"faculty_id": faculty_id, "user_id": None, "faculty_name": faculty_name},
                        "slot1": slot1, "slot2": slot2,
                        "links": {
                            "curriculum_id": cur.get("curriculum_id"),
                            "term_id": term_id,
                            "course_id": course_id,
                            "batch_id": binfo.get("batch_id", ""),
                            "program_id": pid,
                            "section_id": sid
                        },
                        "sizing": sizing_payload(),
                    })


    # ----- deterministic sorting for stable UI (ID → Program → Course → Section no.)
    def _sec_num(code: str) -> int:
        return int("".join(ch for ch in (code or "") if ch.isdigit()) or "0")

    rows.sort(key=lambda r: (
        -(r.get("batch", {}).get("batch_number") or 0),
        (r.get("program", {}).get("program_code") or ""),
        (r.get("block_index") or 1),                                   # <-- group Block 1, then Block 2...
        (r.get("course", {}).get("course_code") or ""),
        _sec_num((r.get("section", {}) or {}).get("section_code") or "")
    ))

    return {
        "campus": campus,
        "term_id": term_id,
        "term_label": term_label(t),
        "filters": {"levels": levels, "departments": dep_opts, "ids": id_opts, "programs": prog_opts},
        "rows": rows,
        "course_options_by_group": options_by_group,
        "room_options": room_opts,
        "planning": {
            "needs_import": needs_import,
            "approval_required": approval_required,
            "pending_changes": pending if approval_required else []
        }
    }

# ---------- POST ----------
@router.post("/courseofferings")
async def post_course_offerings(
    userId: str = Query(..., min_length=3),
    action: Literal[
        "addRow", "editRow", "deleteRow", "forward",
        "curriculumAddCourse", "curriculumEditCourse", "curriculumRemoveCourse",
        "approvePlan"
    ] = Query(...),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    # Ensure a current term
    t = await current_term() or await _ensure_current_term()
    term_id = (t or {}).get("term_id")
    if not term_id:
        raise HTTPException(status_code=400, detail="No active term.")

    campus_id, _ = await apo_scope(userId)
    if not campus_id:
        raise HTTPException(status_code=400, detail="Unable to resolve APO campus from role_assignments.")
    campus = await campus_meta(campus_id)
    prefix = campus_section_prefix(campus.get("campus_name", "")) or ""

    if action == "forward":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload.")
        to = (payload.get("to") or "").strip()
        if not to:
            raise HTTPException(status_code=400, detail="'to' is required.")
        oid = _id("OUT-")
        await db[COL_OUTBOX].insert_one({
            "outbox_id": oid, "to": to,
            "subject": (payload.get("subject") or "").strip(),
            "message": (payload.get("message") or "").strip(),
            "attachment_html": (payload.get("attachment_html") or "").strip(),
            "term_id": term_id, "campus_id": campus_id,
            "created_at": now(), "status": "queued",
        })
        return {"ok": True, "queued": True, "outbox_id": oid}

    if action == "curriculumAddCourse":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload.")
        pid = (payload.get("program_id") or "").strip()
        bid = (payload.get("batch_id") or "").strip()
        course_id = (payload.get("course_id") or "").strip()
        if not pid or not bid:
            raise HTTPException(status_code=422, detail="program_id and batch_id are required.")

        # allow custom course creation with units
        if not course_id and payload.get("new_course"):
            nc = payload["new_course"]
            code = _norm_code(nc.get("course_code"))
            title = (nc.get("course_title") or "").strip()
            dep = (nc.get("department_id") or "").strip()
            lvl = level_code(nc.get("program_level"))
            units = nc.get("units")
            if not (code and title and dep and lvl):
                raise HTTPException(status_code=422, detail="new_course requires course_code, course_title, department_id, program_level.")
            cid = _id("CRS")
            doc = {
                "course_id": cid, "course_code": code, "course_title": title,
                "department_id": dep, "program_level": lvl, "source": "custom",
                "created_at": now(), "updated_at": now()
            }
            if units is not None:
                try:
                    doc["units"] = float(units)
                except Exception:
                    pass
            await db[COL_COURSES].insert_one(doc)
            course_id = cid

        if not course_id:
            raise HTTPException(status_code=422, detail="course_id or new_course must be provided.")

        cur_doc = await db[COL_CURRICULUM].find_one(
            {"term_id": term_id, "campus_id": campus_id, "program_id": pid, "batch_id": bid}
        )
        if not cur_doc:
            await db[COL_CURRICULUM].insert_one({
                "curriculum_id": _id("CURR"),
                "term_id": term_id, "campus_id": campus_id,
                "program_id": pid, "batch_id": bid,
                "course_list": [course_id],
                "created_at": now(), "updated_at": now()
            })
        else:
            await db[COL_CURRICULUM].update_one(
                {"_id": cur_doc["_id"]},
                {"$addToSet": {"course_list": course_id}, "$set": {"updated_at": now()}}
            )
        return {"ok": True, "course_id": course_id}

    if action == "curriculumEditCourse":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload.")
        pid = (payload.get("program_id") or "").strip()
        bid = (payload.get("batch_id") or "").strip()
        old_cid = (payload.get("old_course_id") or "").strip()
        new_cid = (payload.get("new_course_id") or "").strip()
        upd = payload.get("update_course")
        if not (pid and bid and old_cid):
            raise HTTPException(status_code=422, detail="program_id, batch_id, old_course_id are required.")

        cur_doc = await db[COL_CURRICULUM].find_one(
            {"term_id": term_id, "campus_id": campus_id, "program_id": pid, "batch_id": bid}
        )
        if not cur_doc:
            raise HTTPException(status_code=404, detail="Curriculum not found.")

        # inline edit of course fields (title/level/units)
        if upd:
            f: Dict[str, Any] = {}
            if "course_title" in upd:
                f["course_title"] = (upd.get("course_title") or "").strip()
            if "program_level" in upd and upd.get("program_level"):
                f["program_level"] = level_code(upd.get("program_level"))
            if "units" in upd:
                units_val = upd.get("units")
                if units_val in (None, ""):
                    f["units"] = None
                else:
                    try:
                        f["units"] = float(units_val)
                    except Exception:
                        pass
            if f:
                await db[COL_COURSES].update_one({"course_id": old_cid}, {"$set": {**f, "updated_at": now()}})
            return {"ok": True, "course_id": old_cid}

        # replace course id in curriculum list
        if not new_cid:
            raise HTTPException(status_code=422, detail="new_course_id or update_course must be provided.")
        clist = [c for c in ensure_list(cur_doc.get("course_list")) if c != old_cid]
        clist.append(new_cid)
        await db[COL_CURRICULUM].update_one({"_id": cur_doc["_id"]}, {"$set": {"course_list": clist, "updated_at": now()}})
        return {"ok": True, "course_id": new_cid}

    if action == "curriculumRemoveCourse":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload.")
        pid = (payload.get("program_id") or "").strip()
        bid = (payload.get("batch_id") or "").strip()
        cid = (payload.get("course_id") or "").strip()
        if not (pid and bid and cid):
            raise HTTPException(status_code=422, detail="program_id, batch_id, course_id are required.")
        await db[COL_CURRICULUM].update_one(
            {"term_id": term_id, "campus_id": campus_id, "program_id": pid, "batch_id": bid},
            {"$pull": {"course_list": cid}, "$set": {"updated_at": now()}}
        )
        return {"ok": True, "removed": 1}

    if action == "approvePlan":
        # recompute pending using the same logic as GET, then apply
        needs_import, pending, preen_hash, cohort_hash = await _pending_changes(
            term_id=term_id, campus_id=campus_id, campus_prefix=prefix
        )
        if needs_import:
            raise HTTPException(status_code=400, detail="Import Pre-Enlistment first.")

        # base sections per course = at least number of programs that include it
        curr = [x async for x in db[COL_CURRICULUM].find(
            {"term_id": term_id, "campus_id": campus_id},
            {"_id":0,"program_id":1,"course_list":1}
        )]
        course_to_programs: Dict[str, set] = {}
        for c in curr:
            pid = c.get("program_id")
            for cid in ensure_list(c.get("course_list")):
                if pid:
                    course_to_programs.setdefault(cid, set()).add(pid)
        base_by_course: Dict[str, int] = {cid: max(1, len(ps)) for cid, ps in course_to_programs.items()}

        # 1) add courses to curriculum where pending recommends it
        for ch in pending:
            if ch.get("type") == "add_course_to_curriculum":
                cid = ch.get("course_id")
                target = ch.get("target") or {}
                pid = (target.get("program_id") or "").strip()
                bid = (target.get("batch_id") or "").strip()
                if cid and pid and bid:
                    cur_doc = await db[COL_CURRICULUM].find_one({"term_id": term_id, "campus_id": campus_id, "program_id": pid, "batch_id": bid})
                    if not cur_doc:
                        await db[COL_CURRICULUM].insert_one({
                            "curriculum_id": _id("CURR"),
                            "term_id": term_id, "campus_id": campus_id,
                            "program_id": pid, "batch_id": bid,
                            "course_list": [cid],
                            "created_at": now(), "updated_at": now()
                        })
                    else:
                        await db[COL_CURRICULUM].update_one({"_id": cur_doc["_id"]}, {"$addToSet": {"course_list": cid}, "$set": {"updated_at": now()}})

        # 2) adjust sections to match capacity intent
        for ch in pending:
            if ch.get("type") not in {"sections_increase", "sections_decrease"}:
                continue

            cid = (ch.get("course_id") or "").strip()
            if not cid:
                continue

            sec_q = {"term_id": term_id, "course_id": cid}
            if prefix:
                sec_q["section_code"] = {"$regex": f"^{prefix}", "$options": "i"}
            existing = await db[COL_SECTIONS].count_documents(sec_q)

            base = max(1, int(base_by_course.get(cid, 1)))

            if ch["type"] == "sections_increase":
                by_sections = int(ch.get("by_sections") or 0)
                if by_sections <= 0:
                    by_cap = int(ch.get("by_capacity") or 0)
                    by_sections = ceil(by_cap / (DEFAULT_CAP or 20)) if by_cap > 0 else 0

                need_base = max(0, base - existing)
                if need_base:
                    await _create_sections(
                        term_id=term_id, campus_prefix=prefix,
                        course_id=cid, count=need_base, capacity=DEFAULT_CAP
                    )
                    existing += need_base

                if by_sections:
                    await _create_sections(
                        term_id=term_id, campus_prefix=prefix,
                        course_id=cid, count=by_sections, capacity=DEFAULT_CAP
                    )

            else:  # sections_decrease
                by_sections = int(ch.get("by_sections") or 0)
                if by_sections > 0:
                    target = max(base, existing - by_sections)
                else:
                    est = await estimated_demand(term_id, campus_id, cid)
                    target = max(base, ceil((est["plan"] or 0) / (DEFAULT_CAP or 20)) or 1)

                await reduce_sections_if_excess(
                    term_id=term_id, campus_prefix=prefix,
                    course_id=cid, target_count=target
                )

        # mark approved with the exact hashes we just applied
        await db[COL_PLANSTATE].update_one(
            {"term_id": term_id, "campus_id": campus_id},
            {"$set": {"last_preen_hash": preen_hash, "last_cohort_hash": cohort_hash, "approved": True, "updated_at": now()}},
            upsert=True
        )
        return {"ok": True, "applied": len(pending)}

    # ----- Gate manual section edits while plan needs action -----
    plan_warning = False
    if action in {"addRow", "editRow", "deleteRow"}:
        needs_import, approval_required, _pending, _ph, _ch, _st = await _planning_flags(
            term_id=term_id, campus_prefix=prefix, campus_id=campus_id
        )
        if needs_import:
            raise HTTPException(
                status_code=409,
                detail={"code": "NEEDS_IMPORT", "message": "Import Pre-Enlistment (count & statistics) for the current term before editing offerings."}
            )
        # Do NOT block on approval; treat as soft warning that can be overridden
        plan_warning = bool(approval_required)

    # --- section ops ---
    if not payload:
        raise HTTPException(status_code=400, detail="Missing payload.")

    hard = await validate_hard_errors(action, payload, term_id)
    if hard:
        raise HTTPException(status_code=422, detail={"ok": False, "errors": hard})

    soft = await validate_soft_conflicts(
        action=action, payload=payload, campus_prefix=prefix, term_id=term_id, campus_id=campus_id
    )

    # Add a soft warning when plan approval is pending
    if plan_warning:
        soft.append({
            "code": "PLAN_NOT_APPROVED",
            "level": "warning",
            "message": "Planning updates for this term are pending approval. Proceeding will be recorded as an override.",
        })

    # NEW: one-shot auto-override path (no 409/token roundtrip)
    auto_override = bool((payload or {}).get("auto_override"))
    if soft and auto_override:
        reason = (payload.get("override_reason") or "Auto-override from UI").strip() or "Auto-override from UI"
        await audit_override(
            user_id=userId,
            action=action,
            reason=reason,
            violations=soft,
            payload=payload,
        )
        soft = []  # clear warnings and proceed with the requested action

    # Existing token-based override flow (kept for users who want explicit confirm)
    if soft and not payload.get("override"):
        tok = await issue_override_token(user_id=userId, payload=payload, violations=soft, ttl_sec=300)
        preview = {}
        if action == "addRow":
            preview = {
                "section_code": payload.get("section_code") or await next_section_code(prefix, term_id, payload.get("course_id")),
                "enrollment_cap": int(payload.get("enrollment_cap") or DEFAULT_CAP),
            }
        elif action == "editRow":
            preview = {"section_code": payload.get("section_code") or "", "enrollment_cap": payload.get("enrollment_cap")}
        elif action == "deleteRow":
            preview = {"will_delete": True}
        raise HTTPException(
            status_code=409,
            detail={"ok": False, "conflict": True, "override_token": tok, "violations": soft, "preview_changes": preview}
        )

    if payload.get("override"):
        # Require a non-empty override reason
        _reason = (payload.get("override_reason") or "").strip()
        if not _reason:
            raise HTTPException(status_code=422, detail={"ok": False, "errors": [{"code":"OVERRIDE_REASON_REQUIRED","message":"override_reason is required."}]})
        info = await assert_override_token(payload.get("override_token", ""), userId)
        await audit_override(
            user_id=userId, action=action, reason=_reason,
            violations=info.get("violations") or soft, payload=info.get("payload") or payload,
        )

    if action == "addRow":
        batch_id = (payload.get("batch_id") or "").strip()
        course_id = (payload.get("course_id") or "").strip()
        b = await db[COL_BATCHES].find_one({"batch_id": batch_id}, {"_id": 0, "batch_number": 1, "batch_code": 1})
        batch_number = _extract_batch_number(b or {})
        section_code = (payload.get("section_code") or "").strip() or await next_section_code(prefix, term_id, course_id)
        sid = _id("SEC")
        cap = payload.get("enrollment_cap")
        cap = int(cap) if cap not in (None, "") else DEFAULT_CAP
        remarks = (payload.get("remarks") or "").strip()
        doc = {
            "section_id": sid, "section_code": section_code,
            "course_id": course_id, "term_id": term_id,
            "enrollment_cap": cap, "remarks": remarks,
            "batch_number": batch_number,
            # helpful owner hints for future reports (not required by distribution algo)
            "owner_program_id": (payload.get("program_id") or "").strip(),
            "owner_batch_id": (payload.get("batch_id") or "").strip(),
            "created_at": now(), "updated_at": now(),
        }
        inserted = await safe_insert_section(doc)
        if not inserted:
            raise HTTPException(status_code=409, detail="Could not allocate a unique section code. Try again.")
        for idx, key in enumerate(["slot1", "slot2"], start=1):
            s = (payload.get(key) or {})
            rid = (s.get("room_id") or "").strip()
            if rid != "" and rid is not None:
                await db[COL_SCHEDS].insert_one({
                    "schedule_id": f"SCH-{sid}-{idx}",
                    "section_id": sid, "day": "", "start_time": "", "end_time": "",
                    "room_id": rid, "created_at": now(), "updated_at": now(),
                })
        return {"ok": True, "section_id": sid}

    if action == "editRow":
        section_id = (payload.get("section_id") or "").strip()
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
            rid = (s.get("room_id") or "").strip()
            existing = await db[COL_SCHEDS].find_one({"section_id": section_id, "schedule_id": {"$regex": f"^SCH-{section_id}-{idx}$"}})
            if existing:
                await db[COL_SCHEDS].update_one({"schedule_id": existing["schedule_id"]}, {"$set": {"room_id": rid, "updated_at": now()}})
            else:
                await db[COL_SCHEDS].insert_one({
                    "schedule_id": f"SCH-{section_id}-{idx}",
                    "section_id": section_id, "day": "", "start_time": "", "end_time": "",
                    "room_id": rid, "created_at": now(), "updated_at": now(),
                })
        return {"ok": True, "section_id": section_id}

    if action == "deleteRow":
        section_id = (payload.get("section_id") or "").strip()
        await db[COL_SCHEDS].delete_many({"section_id": section_id})
        await db[COL_FAC_ASSIGN].update_many({"section_id": section_id}, {"$set": {"is_archived": True, "updated_at": now()}})
        await db[COL_SECTIONS].delete_one({"section_id": section_id})
        return {"ok": True, "deleted": 1}

    raise HTTPException(status_code=400, detail="Invalid action.")
