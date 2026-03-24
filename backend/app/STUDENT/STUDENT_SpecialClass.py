from __future__ import annotations

from datetime import datetime, timezone
import base64
import binascii
from pathlib import Path
from uuid import uuid4
import re
from typing import Any, Dict, Optional, List, Tuple

from fastapi import APIRouter, HTTPException, Query, Body
from fastapi.responses import Response
from pymongo import ReturnDocument

from ..main import db
from .. import Notifications as _notifications

router = APIRouter(prefix="/student", tags=["student"])

# ---------------- collections ----------------
COL_USERS = "users"
COL_SPECIAL = "special_class"
COL_DEPARTMENTS = "departments"
COL_COURSES = "courses"
COL_PROGRAMS = "programs"
COL_TERMS = "terms"
COL_PREEN_COUNT = "preenlistment_count"
COL_SPECIAL_WINDOWS = "specialclass_windows"

SPECIAL_EAF_UPLOAD_DIR = Path(__file__).resolve().parent.parent / "uploads" / "specialclass_eaf"
SPECIAL_EAF_MAX_BYTES = 5 * 1024 * 1024
SPECIAL_EAF_ALLOWED_EXTS = {".pdf"}
SPECIAL_EAF_ALLOWED_CONTENT_TYPES = {"", "application/pdf", "application/octet-stream"}

COL_SECTIONS = "sections"
COL_SECTION_SCHEDULES = "section_schedules"
COL_FAC_ASSIGN = "faculty_assignments"
COL_FAC_PROFILES = "faculty_profiles"
COL_ROOMS = "rooms"

# ---------------- helpers ----------------

def _upper_name(first: str, last: str) -> str:
    """Return "LAST, FIRST" in upper-case, with sensible fallbacks."""
    first = (first or "").strip()
    last = (last or "").strip()
    if first and last:
        return f"{last.upper()}, {first.upper()}"
    if last:
        return last.upper()
    if first:
        return first.upper()
    return ""

def _now_dt() -> datetime:
    return datetime.now(timezone.utc)

async def _active_term() -> Dict[str, Any]:
    """
    Priority:
    1) active pre-enlistment batch (preenlistment_count where not archived)
    2) next term after current (status=active OR is_current=True)
    3) fallback latest
    """
    pre_doc = await db[COL_PREEN_COUNT].find_one(
        {"is_archived": {"$ne": True}},
        {"_id": 0, "term_id": 1},
    )
    if pre_doc and pre_doc.get("term_id"):
        t = await db[COL_TERMS].find_one(
            {"term_id": pre_doc["term_id"]},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        )
        if t:
            return t

    current = await db[COL_TERMS].find_one(
        {"$or": [{"status": "active"}, {"is_current": True}]},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )

    if not current:
        fallback = await db[COL_TERMS].find(
            {},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        ).sort([("acad_year_start", -1), ("term_number", -1)]).limit(1).to_list(1)
        current = fallback[0] if fallback else None

    if not current:
        return {}

    next_terms = await db[COL_TERMS].find(
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
    ).sort([("acad_year_start", 1), ("term_number", 1)]).limit(1).to_list(1)

    if next_terms:
        return next_terms[0]

    return current



def _parse_date_any(dt):
    if isinstance(dt, datetime):
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    if not dt:
        return None
    try:
        parsed = datetime.fromisoformat(str(dt).replace("Z", "+00:00"))
    except Exception:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


async def _special_window_for_term(term: Dict[str, Any]) -> Dict[str, Any]:
    term = term or {}
    term_id = term.get("term_id")
    if not term_id:
        return {"openISO": "", "deadlineISO": "", "term_id": None}

    override = await db[COL_SPECIAL_WINDOWS].find_one(
        {"term_id": term_id},
        {"_id": 0, "open_dt": 1, "deadline_dt": 1, "openISO": 1, "deadlineISO": 1, "term_id": 1},
    )
    if not override:
        return {"openISO": "", "deadlineISO": "", "term_id": term_id}

    open_dt = _parse_date_any(override.get("open_dt") or override.get("openISO"))
    deadline_dt = _parse_date_any(override.get("deadline_dt") or override.get("deadlineISO"))
    return {
        "openISO": open_dt.isoformat() if open_dt else "",
        "deadlineISO": deadline_dt.isoformat() if deadline_dt else "",
        "term_id": term_id,
    }


def _as_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    s = str(v or "").strip().lower()
    return s in {"1", "true", "yes", "y", "on"}


def _safe_filename(name: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", str(name or "").strip())
    return base.strip("._") or "eaf.pdf"


def _write_eaf_bytes(filename: str, content_type: str, data: bytes) -> Dict[str, Any]:
    filename = _safe_filename(filename or "")
    if not filename:
        raise HTTPException(status_code=400, detail="Please attach your EAF file.")

    ext = Path(filename).suffix.lower()
    if ext not in SPECIAL_EAF_ALLOWED_EXTS:
        raise HTTPException(status_code=400, detail="EAF must be uploaded as a PDF file.")

    content_type = str(content_type or "").split(";")[0].strip().lower()
    if content_type not in SPECIAL_EAF_ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=400, detail="Invalid EAF file type. Please upload a PDF file.")

    if not data:
        raise HTTPException(status_code=400, detail="Uploaded EAF file is empty.")
    if len(data) > SPECIAL_EAF_MAX_BYTES:
        raise HTTPException(status_code=400, detail="EAF file must be 5 MB or smaller.")

    SPECIAL_EAF_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    stored_name = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}_{uuid4().hex}.pdf"
    full_path = SPECIAL_EAF_UPLOAD_DIR / stored_name
    full_path.write_bytes(data)

    return {
        "eaf_original_name": filename,
        "eaf_content_type": content_type or "application/pdf",
        "eaf_size": len(data),
        "eaf_storage_path": str(full_path),
        "eaf_uploaded_at": _now_dt(),
        "eaf_base64": base64.b64encode(data).decode("ascii"),
    }


def _save_eaf_base64(file_name: str, content_type: str, b64data: str) -> Dict[str, Any]:
    if not b64data:
        raise HTTPException(status_code=400, detail="Please attach your EAF file.")
    raw = str(b64data)
    if "," in raw and raw.strip().lower().startswith("data:"):
        raw = raw.split(",", 1)[1]
    try:
        data = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="Uploaded EAF file is invalid or corrupted.")
    return _write_eaf_bytes(file_name, content_type, data)


def _eaf_available(doc: Dict[str, Any]) -> bool:
    raw_path = str(doc.get("eaf_storage_path") or "").strip()
    if raw_path:
        p = Path(raw_path)
        if p.exists() and p.is_file():
            return True
    if str(doc.get("eaf_base64") or "").strip():
        return True
    return False


def _build_eaf_view_url(user_id: str, special_id: str) -> str:
    return f"/api/student/specialclass/eaf?userId={user_id}&specialId={special_id}"


async def _find_course_by_code(code: str) -> Optional[Dict[str, Any]]:
    if not code:
        return None
    code = code.strip().upper()
    doc = await db[COL_COURSES].find_one(
        {
            "$or": [
                {"course_code": code},
                {"course_code": {"$in": [code]}},
                {"course_code": {"$elemMatch": {"$regex": f"^{code}$", "$options": "i"}}},
            ]
        },
        {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1, "department_id": 1, "units": 1},
    )
    if doc:
        cc = doc.get("course_code")
        if isinstance(cc, list):
            doc["course_code"] = cc[0] if cc else ""
    return doc

async def _get_department_by_name(name: str) -> Optional[Dict[str, Any]]:
    if not name:
        return None
    name = name.strip()
    return await db[COL_DEPARTMENTS].find_one(
        {"$or": [{"department_name": name}, {"dept_name": name}]},
        {"_id": 0, "department_id": 1, "department_name": 1, "dept_name": 1},
    )

async def _get_program_by_code(program_code: str) -> Optional[Dict[str, Any]]:
    if not program_code:
        return None
    code = program_code.strip()
    # Be tolerant to case differences.
    return await db[COL_PROGRAMS].find_one(
        {"program_code": {"$regex": f"^{re.escape(code)}$", "$options": "i"}},
        {"_id": 0, "program_id": 1, "program_code": 1},
    )


ALLOWED_PROGRAM_CODES = [
    "BSCS-ST", "BSCS-NIS", "BSCS-CSE", "BSMS-CS",
    "BS IET-GD", "BS IET-AD", "BSIT", "BSIS",
]

ALLOWED_DEPARTMENTS = [
    "Department of Software Technology",
    "Department of Computer Technology",
    "Department of Information Technology",
]

async def _get_special_config() -> Dict[str, Any]:
    cfg = await db[COL_SPECIAL].find_one(
        {"_id": "config", "doc_type": {"$in": ["config", "Config"]}},
        {"_id": 0, "reasons": 1, "statuses": 1, "next_seq": 1},
    )
    if not cfg:
        cfg = {
            "reasons": [
                "Graduating at the end of this Term and course is not offered",
                "Graduating at the end of this Term and course offered is conflict with other enrolled courses",
                "The course is indicated in the program flowchart as a regular offering for the term but is not offered",
                "Other",
            ],
            "statuses": [
                "Forwarded To Department",
                "Approved",
                "Rejected",
            ],
            "next_seq": 0,
        }
        await db[COL_SPECIAL].update_one(
            {"_id": "config"},
            {
                "$set": {
                    "doc_type": "config",
                    "reasons": cfg["reasons"],
                    "statuses": cfg["statuses"],
                },
                "$setOnInsert": {"next_seq": cfg.get("next_seq", 0)},
            },
            upsert=True,
        )

    return cfg

async def _next_special_id() -> str:
    doc = await db[COL_SPECIAL].find_one_and_update(
        {"_id": "config"},
        {"$setOnInsert": {"doc_type": "config"}, "$inc": {"next_seq": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    seq = int((doc or {}).get("next_seq", 1))
    return f"SPCL{seq:04d}"

# ---------- schedule/assignment helpers (student view) ----------

ALLOWED_DAYS = {"M", "T", "W", "H", "F", "S"}
DAY_ORDER = {"M": 1, "T": 2, "W": 3, "H": 4, "F": 5, "S": 6}

def _normalize_day(v: Any) -> str:
    s = str(v or "").strip().upper()
    if not s:
        return ""
    if s in ALLOWED_DAYS:
        return s
    # accept full day names
    mapping = {
        "MONDAY": "M",
        "TUESDAY": "T",
        "WEDNESDAY": "W",
        "THURSDAY": "H",
        "FRIDAY": "F",
        "SATURDAY": "S",
    }
    return mapping.get(s, "")

def _to_hhmm(v: Any) -> str:
    s = str(v or "").strip()
    if not s:
        return ""
    # allow "07:30" etc
    s = s.replace(":", "")
    if len(s) == 3:
        s = "0" + s
    return s if len(s) == 4 and s.isdigit() else ""

def _is_valid_hhmm(s: str) -> bool:
    if not (s and len(s) == 4 and s.isdigit()):
        return False
    hh = int(s[:2])
    mm = int(s[2:])
    return 0 <= hh <= 23 and 0 <= mm <= 59

def _mins(hhmm: str) -> int:
    return int(hhmm[:2]) * 60 + int(hhmm[2:])

async def _bulk_assignment_info(section_ids: List[str]) -> Dict[str, Dict[str, Any]]:
    """
    Returns map:
    section_id -> {
      section_code, enrollment_cap, enrolled,
      faculty_name,
      day1, begin1, end1, room1,
      day2, begin2, end2, room2,
      section_remarks,
      schedule_summary
    }
    """
    sids = sorted({(x or "").strip() for x in section_ids if (x or "").strip()})
    if not sids:
        return {}

    # sections: code + cap/enrolled
    sec_docs = await db[COL_SECTIONS].find(
        {"section_id": {"$in": sids}},
        {"_id": 0, "section_id": 1, "section_code": 1, "enrollment_cap": 1, "enrolled": 1},
    ).to_list(20000)

    sec_code_map = {d["section_id"]: (d.get("section_code") or "").strip() for d in sec_docs if d.get("section_id")}
    sec_cap_map = {d["section_id"]: int(d.get("enrollment_cap") or 0) for d in sec_docs if d.get("section_id")}
    sec_enrolled_map = {d["section_id"]: int(d.get("enrolled") or 0) for d in sec_docs if d.get("section_id")}

    # faculty assignments (pick latest non-archived per section)
    fac_asg = await db[COL_FAC_ASSIGN].find(
        {"section_id": {"$in": sids}, "is_archived": {"$ne": True}},
        {"_id": 0, "section_id": 1, "faculty_id": 1, "faculty_name": 1, "created_at": 1},
    ).sort([("section_id", 1), ("created_at", -1)]).to_list(50000)

    sec_to_fac: Dict[str, Dict[str, str]] = {}  # section_id -> {faculty_id, faculty_name}
    fac_ids: List[str] = []

    for fa in fac_asg:
        sid = (fa.get("section_id") or "").strip()
        if not sid or sid in sec_to_fac:
            continue  # already captured latest

        fid = (fa.get("faculty_id") or "").strip()
        fnm = (fa.get("faculty_name") or "").strip()

        sec_to_fac[sid] = {"faculty_id": fid, "faculty_name": fnm}
        if fid:
            fac_ids.append(fid)

    fac_ids = sorted({x for x in fac_ids if x})

    # faculty_id -> display name, derived like OM/APO: faculty_profiles -> users
    fac_name_by_id: Dict[str, str] = {}
    fac_user_id_by_fac_id: Dict[str, str] = {}

    if fac_ids:
        profs = await db[COL_FAC_PROFILES].find(
            {"faculty_id": {"$in": fac_ids}},
            {"_id": 0, "faculty_id": 1, "user_id": 1, "faculty_name": 1, "first_name": 1, "last_name": 1},
        ).to_list(20000)

        user_ids: List[str] = []
        for p in profs:
            fid = (p.get("faculty_id") or "").strip()
            if not fid:
                continue

            # 1) direct faculty_name on profile (if present)
            nm = (p.get("faculty_name") or "").strip()
            if nm:
                fac_name_by_id[fid] = nm

            # 2) profile may have names directly
            if fid not in fac_name_by_id:
                fn = (p.get("first_name") or "").strip()
                ln = (p.get("last_name") or "").strip()
                nm2 = _upper_name(fn, ln)
                if nm2:
                    fac_name_by_id[fid] = nm2

            # 3) map to users
            uid = (p.get("user_id") or "").strip()
            if uid:
                fac_user_id_by_fac_id[fid] = uid
                user_ids.append(uid)

        user_ids = sorted({u for u in user_ids if u})
        if user_ids:
            users = await db[COL_USERS].find(
                {"$or": [{"user_id": {"$in": user_ids}}, {"userId": {"$in": user_ids}}]},
                {"_id": 0, "user_id": 1, "userId": 1, "first_name": 1, "last_name": 1, "firstName": 1, "lastName": 1},
            ).to_list(20000)

            user_map: Dict[str, Dict[str, Any]] = {}
            for u in users:
                uid = (u.get("user_id") or u.get("userId") or "").strip()
                if uid:
                    user_map[uid] = u

            for fid, uid in fac_user_id_by_fac_id.items():
                if fid in fac_name_by_id:
                    continue
                u = user_map.get(uid)
                if not u:
                    continue
                fn = (u.get("first_name") or u.get("firstName") or "").strip()
                ln = (u.get("last_name") or u.get("lastName") or "").strip()
                nm = _upper_name(fn, ln)
                if nm:
                    fac_name_by_id[fid] = nm

    # fallback: sometimes faculty_id is actually a user_id
    # (rare, but helps legacy data)
    missing_fac_ids = [fid for fid in fac_ids if fid and fid not in fac_name_by_id]
    if missing_fac_ids:
        users = await db[COL_USERS].find(
            {"$or": [{"user_id": {"$in": missing_fac_ids}}, {"userId": {"$in": missing_fac_ids}}]},
            {"_id": 0, "user_id": 1, "userId": 1, "first_name": 1, "last_name": 1, "firstName": 1, "lastName": 1},
        ).to_list(20000)
        for u in users:
            uid = (u.get("user_id") or u.get("userId") or "").strip()
            if not uid or uid in fac_name_by_id:
                continue
            fn = (u.get("first_name") or u.get("firstName") or "").strip()
            ln = (u.get("last_name") or u.get("lastName") or "").strip()
            nm = _upper_name(fn, ln)
            if nm:
                fac_name_by_id[uid] = nm

    # section schedules with room/remarks
    sched_docs = await db[COL_SECTION_SCHEDULES].find(
        {"section_id": {"$in": sids}},
        {"_id": 0, "section_id": 1, "day": 1, "start_time": 1, "end_time": 1, "room_id": 1, "room_code": 1, "remarks": 1},
    ).to_list(50000)

    room_ids: List[str] = []
    grouped: Dict[str, List[Tuple[str, str, str, str]]] = {}  # (day, start, end, room_code_or_room_id)
    remarks_map: Dict[str, str] = {}

    for r in sched_docs:
        sid = (r.get("section_id") or "").strip()
        if not sid:
            continue

        d = _normalize_day(r.get("day"))
        st = _to_hhmm(r.get("start_time"))
        et = _to_hhmm(r.get("end_time"))
        if d not in ALLOWED_DAYS:
            continue
        if not (_is_valid_hhmm(st) and _is_valid_hhmm(et)):
            continue
        if _mins(et) <= _mins(st):
            continue

        rem = str(r.get("remarks") or "").strip()
        if rem and not remarks_map.get(sid):
            remarks_map[sid] = rem

        rc = str(r.get("room_code") or "").strip()
        rid = str(r.get("room_id") or "").strip()
        if (not rc) and rid:
            room_ids.append(rid)

        grouped.setdefault(sid, []).append((d, st, et, rc or rid))

    room_ids = sorted({x for x in room_ids if x})
    room_code_by_id: Dict[str, str] = {}
    if room_ids:
        room_docs = await db[COL_ROOMS].find(
            {"room_id": {"$in": room_ids}},
            {"_id": 0, "room_id": 1, "room_code": 1, "room_number": 1, "room_name": 1},
        ).to_list(20000)
        for rm in room_docs:
            rid = (rm.get("room_id") or "").strip()
            if not rid:
                continue
            code = (rm.get("room_code") or rm.get("room_number") or rm.get("room_name") or "").strip()
            if code:
                room_code_by_id[rid] = code

    def _room_label(v: str) -> str:
        v = (v or "").strip()
        if not v:
            return ""
        return room_code_by_id.get(v, v)

    sched_map: Dict[str, Dict[str, str]] = {}
    for sid, entries in grouped.items():
        entries.sort(key=lambda x: (DAY_ORDER.get(x[0], 99), x[1]))
        entries = entries[:2]

        out = {
            "day1": "", "begin1": "", "end1": "", "room1": "",
            "day2": "", "begin2": "", "end2": "", "room2": "",
        }
        if len(entries) >= 1:
            out["day1"], out["begin1"], out["end1"], out["room1"] = entries[0][0], entries[0][1], entries[0][2], _room_label(entries[0][3])
        if len(entries) >= 2:
            out["day2"], out["begin2"], out["end2"], out["room2"] = entries[1][0], entries[1][1], entries[1][2], _room_label(entries[1][3])

        sched_map[sid] = out

    out_map: Dict[str, Dict[str, Any]] = {}
    for sid in sids:
        scode = sec_code_map.get(sid, "")
        fac_info = sec_to_fac.get(sid, {})
        fid = (fac_info.get("faculty_id") or "").strip()
        facn = (fac_info.get("faculty_name") or "").strip() or (fac_name_by_id.get(fid, "") if fid else "")
        sch = sched_map.get(sid, {
            "day1": "", "begin1": "", "end1": "", "room1": "",
            "day2": "", "begin2": "", "end2": "", "room2": "",
        })

        # summary (compact)
        parts = []
        if sch.get("day1") and sch.get("begin1") and sch.get("end1"):
            parts.append(f'{sch["day1"]} {sch["begin1"]}-{sch["end1"]}')
        if sch.get("day2") and sch.get("begin2") and sch.get("end2"):
            parts.append(f'{sch["day2"]} {sch["begin2"]}-{sch["end2"]}')
        summary = "; ".join(parts)

        out_map[sid] = {
            "section_code": scode,
            "enrollment_cap": int(sec_cap_map.get(sid, 0)),
            "enrolled": int(sec_enrolled_map.get(sid, 0)),
            "faculty_name": facn,
            "section_remarks": (remarks_map.get(sid) or "").strip(),
            **sch,
            "schedule_summary": summary,
        }

    return out_map


# ---------------- route ----------------

@router.get("/specialclass/eaf")
async def special_class_view_eaf(
    userId: str = Query(..., min_length=3),
    specialId: str = Query(..., min_length=3),
):
    doc = await db[COL_SPECIAL].find_one(
        {"user_id": userId, "special_id": specialId},
        {"_id": 0, "eaf_storage_path": 1, "eaf_original_name": 1, "eaf_content_type": 1, "eaf_base64": 1},
    )
    if not doc:
        raise HTTPException(status_code=404, detail="EAF not found.")

    raw_path = str(doc.get("eaf_storage_path") or "").strip()
    if raw_path:
        file_path = Path(raw_path)
        if file_path.exists() and file_path.is_file():
            data = file_path.read_bytes()
            return Response(
                content=data,
                media_type=str(doc.get("eaf_content_type") or "application/pdf"),
                headers={"Content-Disposition": f'inline; filename="{str(doc.get("eaf_original_name") or file_path.name)}"'},
            )

    b64 = str(doc.get("eaf_base64") or "").strip()
    if b64:
        try:
            data = base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(status_code=404, detail="EAF file is unavailable.")
        return Response(
            content=data,
            media_type=str(doc.get("eaf_content_type") or "application/pdf"),
            headers={"Content-Disposition": f'inline; filename="{str(doc.get("eaf_original_name") or "eaf.pdf")}"'},
        )

    raise HTTPException(status_code=404, detail="EAF file is unavailable.")


@router.post("/specialclass")
async def special_class_handler(
    userId: str = Query(..., min_length=3),
    action: str = Query("fetch", description="fetch | submit | options | profile"),
    courseCode: Optional[str] = Query(None, description="Course code (used by courseInfo)"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    # ---------- FETCH (list) ----------
    if action == "fetch":
        pipeline: List[Dict[str, Any]] = [
            {"$match": {"user_id": userId, "special_id": {"$exists": True}}},
            {"$lookup": {"from": COL_TERMS, "localField": "term_id", "foreignField": "term_id", "as": "term"}},
            {"$unwind": {"path": "$term", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": COL_USERS, "localField": "user_id", "foreignField": "user_id", "as": "user"}},
            {"$unwind": {"path": "$user", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": COL_PROGRAMS, "localField": "program_id", "foreignField": "program_id", "as": "prog"}},
            {"$unwind": {"path": "$prog", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": COL_DEPARTMENTS, "localField": "department_id", "foreignField": "department_id", "as": "dept"}},
            {"$unwind": {"path": "$dept", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": COL_COURSES, "localField": "course_id", "foreignField": "course_id", "as": "course"}},
            {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
            {"$addFields": {
                "course_code_display": {
                    "$cond": [
                        {"$isArray": "$course.course_code"},
                        {"$ifNull": [{"$arrayElemAt": ["$course.course_code", 0]}, ""]},
                        {"$ifNull": ["$course.course_code", ""]},
                    ]
                },
                "department_name_display": {"$ifNull": ["$dept.department_name", "$dept.dept_name"]},
            }},
            {"$project": {
                "_id": 0,
                "special_id": 1,
                "user_id": 1,
                "term_id": 1,
                "program_id": 1,
                "department_id": 1,
                "course_id": 1,

                "student_number": 1,
                "units_remaining": 1,
                "graduating_after_term": 1,
                "course_units": 1,

                "reason": 1,
                "reason_other": 1,
                "status": 1,
                "remarks": 1,
                "submitted_at": 1,
                "eaf_original_name": 1,
                "eaf_content_type": 1,
                "eaf_size": 1,
                "eaf_uploaded_at": 1,
                "eaf_storage_path": 1,
                "eaf_base64": 1,

                # assignment ids/fields (if OM already updated record)
                "section_id": 1,
                "section_code": 1,
                "faculty_id": 1,
                "faculty_name": 1,

                # custom schedule (if stored)
                "day1": 1, "begin1": 1, "end1": 1, "room1": 1,
                "day2": 1, "begin2": 1, "end2": 1, "room2": 1,

                # optional section metrics/remarks if stored directly
                "enrollment_cap": 1,
                "enrolled": 1,
                "section_remarks": 1,

                "terms.term_number": "$term.term_number",
                "terms.acad_year_start": "$term.acad_year_start",
                "users.first_name": "$user.first_name",
                "users.last_name": "$user.last_name",
                "programs.program_code": "$prog.program_code",
                "departments.department_name": "$department_name_display",
                "courses.course_code": "$course_code_display",
                "courses.course_title": "$course.course_title",
            }},
            {"$sort": {"submitted_at": -1}},
        ]

        raw_rows = [r async for r in db[COL_SPECIAL].aggregate(pipeline)]

        # resolve section-based schedule/faculty in bulk
        section_ids = [(r.get("section_id") or "").strip() for r in raw_rows if (r.get("section_id") or "").strip()]
        derived_map = await _bulk_assignment_info(section_ids)

        def to_view(r: Dict[str, Any]) -> Dict[str, Any]:
            ay = r.get("terms", {}).get("acad_year_start")

            # base
            section_id = (r.get("section_id") or "").strip() or None
            section_code = (r.get("section_code") or "").strip()

            faculty_name = (r.get("faculty_name") or "").strip()
            day1 = (r.get("day1") or "").strip()
            begin1 = (r.get("begin1") or "").strip()
            end1 = (r.get("end1") or "").strip()
            room1 = (r.get("room1") or "").strip()
            day2 = (r.get("day2") or "").strip()
            begin2 = (r.get("begin2") or "").strip()
            end2 = (r.get("end2") or "").strip()
            room2 = (r.get("room2") or "").strip()

            enrollment_cap = int(r.get("enrollment_cap") or 0)
            enrolled = int(r.get("enrolled") or 0)
            section_remarks = (r.get("section_remarks") or "").strip()

            # derived overrides if section_id exists
            if section_id and section_id in derived_map:
                d = derived_map[section_id]
                if d.get("section_code"):
                    section_code = (d.get("section_code") or "").strip()
                if d.get("faculty_name"):
                    faculty_name = (d.get("faculty_name") or "").strip()

                day1 = (d.get("day1") or "").strip()
                begin1 = (d.get("begin1") or "").strip()
                end1 = (d.get("end1") or "").strip()
                room1 = (d.get("room1") or "").strip()

                day2 = (d.get("day2") or "").strip()
                begin2 = (d.get("begin2") or "").strip()
                end2 = (d.get("end2") or "").strip()
                room2 = (d.get("room2") or "").strip()

                enrollment_cap = int(d.get("enrollment_cap") or 0)
                enrolled = int(d.get("enrolled") or 0)
                section_remarks = (d.get("section_remarks") or "").strip()

                schedule_summary = (d.get("schedule_summary") or "").strip()
            else:
                # summary for custom schedule
                parts = []
                if day1 and begin1 and end1:
                    parts.append(f"{day1} {begin1}-{end1}")
                if day2 and begin2 and end2:
                    parts.append(f"{day2} {begin2}-{end2}")
                schedule_summary = "; ".join(parts)

            return {
                "special_id": r.get("special_id", ""),
                "user_id": r.get("user_id", ""),
                "course_id": r.get("course_id"),
                "has_eaf": _eaf_available(r),
                "eaf_original_name": r.get("eaf_original_name", ""),
                "eaf_content_type": r.get("eaf_content_type", ""),
                "eaf_size": r.get("eaf_size", 0),
                "eaf_uploaded_at": r.get("eaf_uploaded_at"),
                "eaf_view_url": _build_eaf_view_url(r.get("user_id", ""), r.get("special_id", "")),

                "course_code": r.get("courses", {}).get("course_code", ""),
                "course_title": r.get("courses", {}).get("course_title", ""),
                "department_name": r.get("departments", {}).get("department_name", ""),

                "student_number": r.get("student_number", ""),
                "units_remaining": r.get("units_remaining", 0),
                "graduating_after_term": r.get("graduating_after_term", False),
                "course_units": r.get("course_units", 0),

                "reason": r.get("reason", ""),
                "reason_other": r.get("reason_other", ""),

                "status": r.get("status", ""),
                "remarks": r.get("remarks", ""),
                "submitted_at": r.get("submitted_at"),

                "acad_year_start": ay,
                "term_number": r.get("terms", {}).get("term_number"),
                "program_code": r.get("programs", {}).get("program_code", ""),

                # ✅ schedule table fields
                "section_id": section_id,
                "section_code": section_code,
                "faculty_name": faculty_name or "UNASSIGNED",

                "day1": day1,
                "begin1": begin1,
                "end1": end1,
                "room1": room1,

                "day2": day2,
                "begin2": begin2,
                "end2": end2,
                "room2": room2,

                "enrollment_cap": enrollment_cap,
                "enrolled": enrolled,
                "section_remarks": section_remarks,

                "schedule_summary": schedule_summary,
            }

        return {"ok": True, "applications": [to_view(x) for x in raw_rows]}

    # ---------- PROFILE ----------
    if action == "profile":
        u = await db[COL_USERS].find_one(
            {"user_id": userId},
            {"_id": 0, "first_name": 1, "last_name": 1, "student_number": 1, "program_id": 1},
        )
        program_code = ""
        if u and u.get("program_id"):
            p = await db[COL_PROGRAMS].find_one(
                {"program_id": u["program_id"]},
                {"_id": 0, "program_code": 1},
            )
            program_code = (p or {}).get("program_code", "") or ""

        return {
            "ok": bool(u),
            "first_name": (u or {}).get("first_name", ""),
            "last_name": (u or {}).get("last_name", ""),
            "student_number": str((u or {}).get("student_number", "") or ""),
            "program_code": program_code,
        }

    # ---------- OPTIONS ----------
    if action == "options":
        cfg = await _get_special_config()
        dept_names = ALLOWED_DEPARTMENTS[:]

        # Programs dropdown should come only from real DB programs (like Student Petition).
        # No placeholder/allowed-code injection here—frontend should never be offered a value
        # that later fails validation.
        programs_out = [
            p async for p in db[COL_PROGRAMS].find(
                {},
                {"_id": 0, "program_id": 1, "program_code": 1},
            )
        ]
        programs_out.sort(key=lambda x: (x.get("program_code") or ""))

        dept_docs = [d async for d in db[COL_DEPARTMENTS].find(
            {"$or": [{"department_name": {"$in": ALLOWED_DEPARTMENTS}},
                     {"dept_name": {"$in": ALLOWED_DEPARTMENTS}}]},
            {"_id": 0, "department_id": 1, "department_name": 1, "dept_name": 1},
        )]
        dept_ids = [d["department_id"] for d in dept_docs if d.get("department_id")]

        pipeline = [
            {"$match": {"department_id": {"$in": dept_ids}}} if dept_ids else {"$match": {}},
            {"$lookup": {
                "from": COL_DEPARTMENTS,
                "localField": "department_id",
                "foreignField": "department_id",
                "as": "dept",
            }},
            {"$unwind": {"path": "$dept", "preserveNullAndEmptyArrays": True}},
            {"$project": {
                "_id": 0,
                "course_code": {
                    "$cond": [
                        {"$isArray": "$course_code"},
                        {"$ifNull": [{"$arrayElemAt": ["$course_code", 0]}, ""]},
                        {"$ifNull": ["$course_code", ""]},
                    ]
                },
                "course_title": 1,
                "units": {"$ifNull": ["$units", 0]},
                "dept_name": {"$ifNull": ["$dept.department_name", "$dept.dept_name"]},
            }},
            {"$sort": {"dept_name": 1, "course_code": 1}},
        ]
        courses = [c async for c in db[COL_COURSES].aggregate(pipeline)]

        active_term = await _active_term()
        submission_window = await _special_window_for_term(active_term)

        return {
            "ok": True,
            "departments": dept_names,
            "courses": courses,
            "programs": programs_out,
            "reasons": cfg.get("reasons", []),
            "statuses": cfg.get("statuses", []),
            "submission_window": submission_window,
        }

    # ---------- COURSE INFO (units/title/department from DB) ----------
    # Used by Student Special Class form to auto-fill units when course is selected.
    if action == "courseInfo":
        code = str(courseCode or "").strip().upper()
        if not code:
            raise HTTPException(status_code=400, detail="Missing courseCode")

        course = await _find_course_by_code(code)
        if not course:
            raise HTTPException(status_code=404, detail="Course code not found")

        dept_name = ""
        if course.get("department_id"):
            dept = await db[COL_DEPARTMENTS].find_one(
                {"department_id": course["department_id"]},
                {"_id": 0, "department_name": 1, "dept_name": 1},
            )
            dept_name = (dept or {}).get("department_name") or (dept or {}).get("dept_name") or ""

        try:
            units = int(course.get("units") or 0)
        except Exception:
            units = 0

        return {
            "ok": True,
            "course_code": course.get("course_code", code),
            "course_title": course.get("course_title", "") or "",
            "units": units,
            "department_name": dept_name,
        }

    # ---------- SUBMIT ----------
    if action == "submit":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload")

        required = [
            "studentNumber",
            "degree",
            "unitsRemaining",
            "graduatingAfterTerm",
            "courseCode",
            "units",
            "reason",
            "department",
            "agree",
        ]
        for k in required:
            if payload.get(k) is None or str(payload.get(k)).strip() == "":
                raise HTTPException(status_code=400, detail="All required fields must be filled.")

        sn = str(payload["studentNumber"]).strip()
        if not (sn.isdigit() and len(sn) == 8):
            raise HTTPException(status_code=400, detail="Student number must be exactly 8 digits.")

        if _as_bool(payload.get("agree")) is not True:
            raise HTTPException(status_code=400, detail="You must agree to the Terms and Conditions.")

        eaf_meta = _save_eaf_base64(
            str(payload.get("eafFileName") or ""),
            str(payload.get("eafContentType") or "application/pdf"),
            str(payload.get("eafBase64") or ""),
        )

        degree = str(payload["degree"]).strip()
        prog = await _get_program_by_code(degree)
        if not prog:
            raise HTTPException(status_code=400, detail="Selected program not found.")

        try:
            units_remaining = int(payload["unitsRemaining"])
        except Exception:
            raise HTTPException(status_code=400, detail="Units Remaining must be a number.")
        if units_remaining < 0:
            raise HTTPException(status_code=400, detail="Units Remaining cannot be negative.")

        graduating_after_term = _as_bool(payload["graduatingAfterTerm"])

        cfg = await _get_special_config()
        reasons = set(cfg.get("reasons", []))
        reason = str(payload["reason"]).strip()
        if reason not in reasons:
            raise HTTPException(status_code=400, detail="Invalid reason value.")

        reason_other = str(payload.get("reasonOther") or "").strip()
        if reason == "Other" and not reason_other:
            raise HTTPException(status_code=400, detail="Please specify your reason for 'Other'.")

        dept_name = str(payload["department"]).strip()
        if dept_name not in set(ALLOWED_DEPARTMENTS):
            raise HTTPException(status_code=400, detail="Invalid department value.")
        dept = await _get_department_by_name(dept_name)
        if not dept:
            raise HTTPException(status_code=400, detail="Selected department not found.")

        course = await _find_course_by_code(str(payload["courseCode"]).strip())
        if not course:
            raise HTTPException(status_code=400, detail="Course code not found.")

        if course.get("department_id") and dept.get("department_id") and course["department_id"] != dept["department_id"]:
            raise HTTPException(status_code=400, detail="Course does not belong to the selected department.")

        # IMPORTANT: always derive units from the DB to keep student submissions consistent.
        # (Frontend auto-fills units on course selection, but we still enforce DB truth here.)
        try:
            course_units = int(course.get("units") or 0)
        except Exception:
            course_units = 0
        if course_units <= 0:
            raise HTTPException(status_code=400, detail="Course units not found for the selected course.")

        active_term = await _active_term()
        term_id = active_term.get("term_id", "")
        if not term_id:
            raise HTTPException(status_code=503, detail="No active term configured.")

        submission_window = await _special_window_for_term(active_term)
        open_dt = _parse_date_any(submission_window.get("openISO"))
        deadline_dt = _parse_date_any(submission_window.get("deadlineISO"))
        now = _now_dt()
        if not open_dt or not deadline_dt:
            raise HTTPException(status_code=403, detail="Special class submission window has not been started.")
        if open_dt.tzinfo is None:
            open_dt = open_dt.replace(tzinfo=timezone.utc)
        if deadline_dt.tzinfo is None:
            deadline_dt = deadline_dt.replace(tzinfo=timezone.utc)
        if now < open_dt:
            raise HTTPException(status_code=403, detail="Special class submission window has not started yet.")
        if now > deadline_dt:
            raise HTTPException(status_code=403, detail="Special class submission deadline has passed.")

        dup = await db[COL_SPECIAL].find_one({
            "user_id": userId,
            "course_id": course["course_id"],
            "term_id": term_id,
            "special_id": {"$exists": True},
        })
        if dup:
            raise HTTPException(status_code=409, detail="You already submitted a Special Class application for this course this term.")

        # Always start at Forwarded To Department (do NOT rely on config order)
        initial_status = "Forwarded To Department"


        special_id = await _next_special_id()

        doc = {
            "special_id": special_id,
            "user_id": userId,
            "term_id": term_id,
            "program_id": prog["program_id"],
            "department_id": dept["department_id"],
            "course_id": course["course_id"],

            "student_number": int(sn),
            "units_remaining": units_remaining,
            "graduating_after_term": graduating_after_term,

            "course_units": course_units,
            "reason": reason,
            "reason_other": reason_other,

            **eaf_meta,

            "status": initial_status,
            "remarks": "",
            "submitted_at": _now_dt(),
        }

        await db[COL_SPECIAL].insert_one(doc)

        # ------------------------------------------------------------------
        # Notify OM (in-app + Gmail) about the newly submitted Special Class.
        # IMPORTANT: Best-effort only — student submission must succeed even
        # if notification delivery fails due to missing OM accounts/tokens.
        # ------------------------------------------------------------------
        try:
            om_ids = await _notifications._get_all_om_user_ids()
            if om_ids:
                # Resolve student display name (best-effort)
                student = await db[COL_USERS].find_one(
                    {"user_id": userId},
                    {"_id": 0, "first_name": 1, "last_name": 1, "email": 1, "gmail": 1, "student_number": 1},
                ) or {}
                student_name = (f"{(student.get('first_name') or '').strip()} {(student.get('last_name') or '').strip()}".strip() or userId)

                course_code_disp = course.get("course_code", "")
                if isinstance(course_code_disp, list):
                    course_code_disp = course_code_disp[0] if course_code_disp else ""
                course_code_disp = str(course_code_disp or "").strip() or str(payload.get("courseCode") or "").strip()

                title = "New Special Class submission"
                details = (
                    f"Student: {student_name}\n"
                    f"Student No.: {sn}\n"
                    f"Special ID: {special_id}\n"
                    f"Course: {course_code_disp} — {course.get('course_title', '')}\n"
                    f"Department: {dept_name}\n"
                    f"Term: AY {active_term.get('acad_year_start')} — Term {active_term.get('term_number')}"
                )

                meta = {
                    "kind": "student_specialclass_submitted",
                    "route": "/om/home/special-class",
                    "special_id": special_id,
                    "term_id": term_id,
                    "course_id": course.get("course_id"),
                    "student_user_id": userId,
                }

                for om_uid in om_ids:
                    try:
                        await _notifications.create_notification(
                            om_uid,
                            title=title,
                            details=details,
                            meta=meta,
                            send_email=True,
                            email_from_user_id=userId,
                        )
                    except Exception:
                        # best-effort per recipient
                        continue
        except Exception:
            pass

        return {"ok": True, "application": {
            "special_id": special_id,
            "user_id": userId,
            "course_id": course["course_id"],
            "has_eaf": True,
            "eaf_original_name": eaf_meta.get("eaf_original_name", ""),
            "eaf_content_type": eaf_meta.get("eaf_content_type", ""),
            "eaf_size": eaf_meta.get("eaf_size", 0),
            "eaf_uploaded_at": eaf_meta.get("eaf_uploaded_at"),
            "eaf_view_url": _build_eaf_view_url(userId, special_id),
            "course_code": course.get("course_code", ""),
            "course_title": course.get("course_title", ""),
            "department_name": dept_name,
            "course_units": course_units,
            "units_remaining": units_remaining,
            "graduating_after_term": graduating_after_term,
            "reason": reason,
            "reason_other": reason_other,
            "status": doc["status"],
            "remarks": doc["remarks"],
            "submitted_at": doc["submitted_at"],
            "acad_year_start": active_term.get("acad_year_start"),
            "term_number": active_term.get("term_number"),
            "program_code": prog.get("program_code", ""),
            # assignment fields empty on submit
            "section_id": None,
            "section_code": "",
            "faculty_name": "UNASSIGNED",
            "day1": "", "begin1": "", "end1": "", "room1": "",
            "day2": "", "begin2": "", "end2": "", "room2": "",
            "enrollment_cap": 0,
            "enrolled": 0,
            "section_remarks": "",
            "schedule_summary": "",
        }}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
