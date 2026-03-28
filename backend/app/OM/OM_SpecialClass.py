from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple
import base64
import binascii
import io
from pathlib import Path
import uuid

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from pymongo import ASCENDING, ReturnDocument
from pymongo.errors import DuplicateKeyError

from ..main import db
from ..Notifications import create_notification

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
COL_ROOMS = "rooms"

COL_SECTIONS_SUBMITTED = "sections_submitted"
COL_SPECIAL_WINDOWS = "specialclass_windows"
COL_CLASS_RETENTION = "class_retention"

COL_SECTIONS = "sections"
COL_SECTION_SCHEDULES = "section_schedules"
COL_FAC_ASSIGN = "faculty_assignments"
COL_FAC_PROFILES = "faculty_profiles"
COL_FAC_LOADS = "faculty_loads"
COL_PREEN_COUNT = "preenlistment_count"

# RFC (shared with Load Assignment). We reuse this collection for Special Class
# conversation threads keyed by (term_id + section_id), where section_id == special_id.
COL_LOAD_RFC = "faculty_rfc"

OM_ALLOWED_STATUSES = ["Forwarded To Department", "Approved", "Rejected", "Convert to Regular Class"]

# ---------------- notifications (CHAIR) ----------------
# These collections are intentionally named generically so they can be consumed by
# existing notification / email workers elsewhere in the codebase.
COL_NOTIFICATIONS = "notifications"
COL_EMAIL_QUEUE = "email_queue"


def _now_utc() -> datetime:
    return datetime.utcnow()


def _safe_str(x: Any) -> str:
    return str(x).strip() if x is not None else ""


async def _department_campus_id_for_course(course_id: str) -> str:
    course_id = _safe_str(course_id)
    if not course_id:
        return ""
    course = await db[COL_COURSES].find_one({"course_id": course_id}, {"_id": 0, "department_id": 1}) or {}
    dept_id = _safe_str(course.get("department_id"))
    if not dept_id:
        return ""
    dept = await db[COL_DEPARTMENTS].find_one(
        {"department_id": dept_id},
        {"_id": 0, "campus_id": 1, "campus": 1},
    ) or {}
    return _safe_str(dept.get("campus_id") or dept.get("campus")).upper()


async def _regularization_snapshot(section_id: str, course_id: str) -> Dict[str, Any]:
    section_id = _safe_str(section_id)
    course_id = _safe_str(course_id)

    sec = {}
    sub = {}
    if section_id:
        sec = await db[COL_SECTIONS].find_one(
            {"section_id": section_id},
            {"_id": 0, "section_code": 1, "campus_id": 1, "enrollment_cap": 1, "batch_number": 1, "mode": 1, "course_id": 1, "term_id": 1},
        ) or {}
        sub = await db[COL_SECTIONS_SUBMITTED].find_one(
            {"section_id": section_id},
            {"_id": 0, "section_code": 1, "campus_id": 1, "enrollment_cap": 1, "batch_number": 1, "mode": 1, "course_id": 1, "term_id": 1},
        ) or {}

    campus_id = _safe_str(sec.get("campus_id") or sub.get("campus_id")).upper()
    if not campus_id:
        campus_id = await _department_campus_id_for_course(course_id or _safe_str(sec.get("course_id") or sub.get("course_id")))

    section_code = _safe_str(sec.get("section_code") or sub.get("section_code"))

    def _coerce_int(value: Any, default: int) -> int:
        try:
            return int(value)
        except Exception:
            return default

    return {
        "section_code": section_code,
        "campus_id": campus_id,
        "enrollment_cap": _coerce_int(sec.get("enrollment_cap") or sub.get("enrollment_cap"), 45),
        "batch_number": _coerce_int(sec.get("batch_number") or sub.get("batch_number"), 0),
        "mode": _safe_str(sec.get("mode") or sub.get("mode")) or "HYB",
    }


async def _sync_regularized_special_sections(term_id: str) -> None:
    term_id = _safe_str(term_id)
    if not term_id:
        return

    rows = await db[COL_SPECIAL].find(
        {"term_id": term_id, "status": "Convert to Regular Class"},
        {"_id": 0, "section_id": 1, "assignment_id": 1, "course_id": 1},
    ).to_list(5000)

    if not rows:
        return

    assignment_ids = sorted({_safe_str(r.get("assignment_id")) for r in rows if _safe_str(r.get("assignment_id"))})
    assignment_to_section: Dict[str, str] = {}
    if assignment_ids:
        asg_docs = await db[COL_FAC_ASSIGN].find(
            {"assignment_id": {"$in": assignment_ids}, "is_archived": {"$ne": True}},
            {"_id": 0, "assignment_id": 1, "section_id": 1},
        ).to_list(5000)
        assignment_to_section = {
            _safe_str(a.get("assignment_id")): _safe_str(a.get("section_id"))
            for a in asg_docs or []
            if _safe_str(a.get("assignment_id")) and _safe_str(a.get("section_id"))
        }

    seen: set[tuple[str, str]] = set()
    for row in rows:
        course_id = _safe_str(row.get("course_id"))
        section_id = _safe_str(row.get("section_id")) or assignment_to_section.get(_safe_str(row.get("assignment_id")), "")
        if not section_id:
            continue
        key = (section_id, course_id)
        if key in seen:
            continue
        seen.add(key)
        await _regularize_special_section_bundle(section_id=section_id, term_id=term_id, course_id=course_id)


def _is_convert_to_special_status(value: Any) -> bool:
    s = _safe_str(value).lower()
    return s in {"convert to special class", "special class"}


def _eaf_available(doc: Dict[str, Any]) -> bool:
    raw_path = _safe_str(doc.get("eaf_storage_path"))
    if raw_path:
        try:
            file_path = Path(raw_path)
            if file_path.exists() and file_path.is_file():
                return True
        except Exception:
            pass
    return bool(_safe_str(doc.get("eaf_base64")))


def _build_admin_eaf_view_url(router_prefix: str, special_id: str) -> str:
    sid = _safe_str(special_id)
    if not sid:
        return ""
    return f"/api/{router_prefix}/specialclass?action=eaf&specialId={sid}"


def _inline_eaf_response(doc: Dict[str, Any]) -> Response:
    raw_path = _safe_str(doc.get("eaf_storage_path"))
    if raw_path:
        try:
            file_path = Path(raw_path)
            if file_path.exists() and file_path.is_file():
                data = file_path.read_bytes()
                return Response(
                    content=data,
                    media_type=_safe_str(doc.get("eaf_content_type")) or "application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{_safe_str(doc.get("eaf_original_name")) or file_path.name}"'},
                )
        except Exception:
            pass

    b64 = _safe_str(doc.get("eaf_base64"))
    if b64:
        try:
            data = base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(status_code=404, detail="EAF file is unavailable.")
        return Response(
            content=data,
            media_type=_safe_str(doc.get("eaf_content_type")) or "application/pdf",
            headers={"Content-Disposition": f'inline; filename="{_safe_str(doc.get("eaf_original_name")) or "eaf.pdf"}"'},
        )

    raise HTTPException(status_code=404, detail="EAF file is unavailable.")


def _scope_has_department(scope_val: Any, dept_id: str) -> bool:
    if not scope_val or not dept_id:
        return False
    if isinstance(scope_val, dict):
        scope_val = [scope_val]
    if not isinstance(scope_val, list):
        return False
    for s in scope_val:
        if not isinstance(s, dict):
            continue
        stype = _safe_str(s.get("type")).lower()
        if stype and stype != "department":
            continue
        cand = _safe_str(s.get("id") or s.get("department_id") or s.get("dept_id"))
        if cand and cand == dept_id:
            return True
    return False


async def _find_chair_users_for_department(dept_id: str) -> List[Dict[str, Any]]:
    """Best-effort lookup of chair users for a department.

    Why this exists:
    - Some deployments store the chair role text directly on role_assignments (role/role_name/role_title).
    - Others store only a role_id and keep the human-readable name in user_roles/roles collections.
    - Some chairs are stored as staff_profiles with a position_title containing "Chair".

    This function tries all of the above so CHAIR reliably receives notifications.
    """
    dept_id = _safe_str(dept_id)
    if not dept_id:
        return []

    # Known role_ids that represent a CHAIR in this deployment.
    # Some databases don't populate the role catalog (user_roles/roles) with human-readable
    # text ("Chair"), so we include an explicit fallback to ensure the correct recipient.
    #
    # Project-specific mapping:
    # - ROLE0002 => Chair
    CHAIR_ROLE_IDS = {"ROLE0002"}

    # Cache role_id -> role text lookups (best-effort).
    role_text_cache: Dict[str, str] = {}

    async def _role_text_for_assignment(r: Dict[str, Any]) -> str:
        parts = [
            _safe_str(r.get("role")),
            _safe_str(r.get("role_name")),
            _safe_str(r.get("role_title")),
            _safe_str(r.get("role_code")),
        ]
        rt = " ".join([p for p in parts if p]).strip().lower()
        if "chair" in rt:
            return rt

        rid = _safe_str(r.get("role_id") or r.get("roleId") or r.get("roleID"))
        if not rid:
            return rt

        if rid in role_text_cache:
            return (rt + " " + role_text_cache[rid]).strip()

        resolved = ""
        # user_roles is used elsewhere in the codebase as the canonical role catalog.
        try:
            doc = await db.user_roles.find_one(
                {"$or": [{"role_id": rid}, {"roleId": rid}, {"role_code": rid}, {"code": rid}]},
                {"_id": 0, "role_id": 1, "role_name": 1, "role_title": 1, "name": 1, "title": 1, "code": 1},
            ) or {}
            resolved = " ".join([
                _safe_str(doc.get("role_name")),
                _safe_str(doc.get("role_title")),
                _safe_str(doc.get("name")),
                _safe_str(doc.get("title")),
                _safe_str(doc.get("code")),
            ]).strip().lower()
        except Exception:
            resolved = ""

        # Some projects use a generic "roles" collection.
        if (not resolved) and hasattr(db, "roles"):
            try:
                doc = await db.roles.find_one(
                    {"$or": [{"role_id": rid}, {"roleId": rid}, {"code": rid}, {"name": rid}]},
                    {"_id": 0, "role_name": 1, "role_title": 1, "name": 1, "title": 1, "code": 1},
                ) or {}
                resolved = " ".join([
                    _safe_str(doc.get("role_name")),
                    _safe_str(doc.get("role_title")),
                    _safe_str(doc.get("name")),
                    _safe_str(doc.get("title")),
                    _safe_str(doc.get("code")),
                ]).strip().lower()
            except Exception:
                resolved = ""

        role_text_cache[rid] = resolved
        return (rt + " " + resolved).strip()

    chair_user_ids: List[str] = []

    # 1) role_assignments (preferred; mirrors scoping logic used elsewhere)
    try:
        ras = await db.role_assignments.find(
            {
                "is_active": {"$in": [True, None]},
                "$or": [
                    {"department_id": dept_id},
                    {"dept_id": dept_id},
                    {"scope": {"$exists": True}},
                ],
            },
            {
                "_id": 0,
                "user_id": 1,
                "role": 1,
                "role_name": 1,
                "role_title": 1,
                "role_code": 1,
                "role_id": 1,
                "roleId": 1,
                "department_id": 1,
                "dept_id": 1,
                "scope": 1,
            },
        ).to_list(1000)
    except Exception:
        ras = []

    for r in ras or []:
        role_text = await _role_text_for_assignment(r)
        rid = _safe_str(r.get("role_id") or r.get("roleId") or r.get("roleID"))
        is_chair = ("chair" in role_text) or (rid in CHAIR_ROLE_IDS)
        dept_match = (_safe_str(r.get("department_id")) == dept_id) or (_safe_str(r.get("dept_id")) == dept_id)
        scope_match = _scope_has_department(r.get("scope"), dept_id)

        if is_chair and (dept_match or scope_match):
            uid = _safe_str(r.get("user_id"))
            if uid:
                chair_user_ids.append(uid)

    # 2) staff_profiles fallback (position_title contains chair)
    if not chair_user_ids:
        try:
            sp_docs = await db.staff_profiles.find(
                {
                    "$or": [{"department_id": dept_id}, {"dept_id": dept_id}],
                    "user_id": {"$exists": True},
                    "$or": [
                        {"position_title": {"$regex": "chair", "$options": "i"}},
                        {"position": {"$regex": "chair", "$options": "i"}},
                        {"role_title": {"$regex": "chair", "$options": "i"}},
                    ],
                },
                {"_id": 0, "user_id": 1},
            ).to_list(50)
            for sp in sp_docs or []:
                uid = _safe_str(sp.get("user_id"))
                if uid:
                    chair_user_ids.append(uid)
        except Exception:
            pass

    chair_user_ids = list(dict.fromkeys([u for u in chair_user_ids if u]))
    if not chair_user_ids:
        return []

    users = await db[COL_USERS].find(
        {"user_id": {"$in": chair_user_ids}},
        {"_id": 0, "user_id": 1, "email": 1, "first_name": 1, "last_name": 1},
    ).to_list(1000)
    return users or []



async def _notify_user_inapp(user_id: str, title: str, message: str, data: Optional[Dict[str, Any]] = None) -> None:
    user_id = _safe_str(user_id)
    if not user_id:
        return
    doc = {
        "notification_id": f"notif_{uuid.uuid4().hex}",
        "user_id": user_id,
        "title": title,
        "message": message,
        "data": data or {},
        "is_read": False,
        "created_at": _now_utc(),
        "updated_at": _now_utc(),
        "channel": "in_app",
    }
    try:
        await db[COL_NOTIFICATIONS].insert_one(doc)
    except Exception:
        # Notifications must never block the main update path.
        return


async def _queue_email(to_email: str, subject: str, text_body: str) -> None:
    to_email = _safe_str(to_email)
    if not to_email:
        return
    doc = {
        "email_id": f"email_{uuid.uuid4().hex}",
        "to": to_email,
        "subject": subject,
        "text": text_body,
        "created_at": _now_utc(),
        "updated_at": _now_utc(),
        "status": "pending",
        "provider": "gmail",
    }
    try:
        await db[COL_EMAIL_QUEUE].insert_one(doc)
    except Exception:
        return


async def _notify_chairs_for_specialclass(
    dept_id: str,
    kind: str,  # "new" | "update"
    special_id: str,
    summary: str,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    dept_id = _safe_str(dept_id)
    special_id = _safe_str(special_id)
    if not dept_id or not special_id:
        return

    users = await _find_chair_users_for_department(dept_id)
    if not users:
        return

    # Use the shared Notifications module so CHAIR receives the same in-app feed and
    # best-effort Gmail email behavior used across the system.
    title = "New Special Class" if kind == "new" else "Special Class updated"
    details = summary
    meta: Dict[str, Any] = {
        "route": "/chair/plantilla",
        "kind": "special_class_reflection",
        "event": kind,
        "special_id": special_id,
        "department_id": dept_id,
    }
    if extra:
        meta.update(extra)

    for u in users:
        uid = _safe_str(u.get("user_id"))
        if not uid:
            continue
        # In-app + Gmail
        await create_notification(
            user_id=uid,
            title=title,
            details=details,
            meta=meta,
            send_email=True,
        )



# ---------------- notifications (APO) ----------------
async def _apo_user_ids_for_campus(campus_id: str) -> List[str]:
    """Return APO user_ids scoped to a campus (best-effort)."""
    campus_id = _safe_str(campus_id).upper()
    if not campus_id:
        return []

    role_apo = ""
    try:
        role_doc = await db.get_collection("user_roles").find_one(
            {"role_type": {"$regex": "APO", "$options": "i"}},
            {"_id": 0, "role_id": 1},
        )
        role_apo = _safe_str((role_doc or {}).get("role_id"))
    except Exception:
        role_apo = ""

    if not role_apo:
        role_apo = "ROLE0004"

    def _scope_has_campus(scope_val) -> bool:
        if not scope_val:
            return False
        scopes = scope_val if isinstance(scope_val, list) else [scope_val]
        for s in scopes:
            if not isinstance(s, dict):
                continue
            typ = _safe_str(s.get("type") or s.get("scope_type")).lower()
            sid = _safe_str(s.get("id") or s.get("scope_id") or s.get("campus_id")).upper()
            if sid == campus_id and (typ in ("campus", "campuses", "") or "campus" in typ):
                return True
        return False

    out: set[str] = set()

    try:
        docs = (
            await db.get_collection("role_assignments")
            .find({"role_id": role_apo}, {"_id": 0, "user_id": 1, "scope": 1})
            .to_list(None)
        )
    except Exception:
        docs = []

    for d in docs or []:
        uid = _safe_str(d.get("user_id"))
        if uid and _scope_has_campus(d.get("scope")):
            out.add(uid)

    # legacy fallback
    try:
        cur = db.get_collection(COL_USERS).find(
            {"role": {"$regex": "APO", "$options": "i"}, "campus_id": campus_id},
            {"_id": 0, "user_id": 1},
        )
        async for u in cur:
            uid = _safe_str(u.get("user_id"))
            if uid:
                out.add(uid)
    except Exception:
        pass

    return sorted(list(out))


async def _all_apo_user_ids() -> List[str]:
    uids: set[str] = set()

    try:
        role_doc = await db["user_roles"].find_one({"role_type": {"$regex": "APO", "$options": "i"}}, {"_id": 0, "role_id": 1})
        role_id = _safe_str((role_doc or {}).get("role_id"))
        if role_id:
            cur = db["role_assignments"].find({"role_id": role_id}, {"_id": 0, "user_id": 1})
            async for r in cur:
                uid = _safe_str((r or {}).get("user_id"))
                if uid:
                    uids.add(uid)
    except Exception:
        pass

    try:
        cur2 = db[COL_USERS].find({"role": {"$regex": r"\bAPO\b", "$options": "i"}}, {"_id": 0, "user_id": 1})
        async for r in cur2:
            uid = _safe_str((r or {}).get("user_id"))
            if uid:
                uids.add(uid)
    except Exception:
        pass

    return sorted(list(uids))


async def _campus_id_for_special_doc(doc: Dict[str, Any]) -> str:
    """Infer campus_id for a special_class doc (best-effort)."""
    # 1) Linked section
    sid = _safe_str(doc.get("section_id"))
    if sid:
        try:
            sec = await db[COL_SECTIONS].find_one({"section_id": sid}, {"_id": 0, "campus_id": 1}) or {}
            cid = _safe_str(sec.get("campus_id")).upper()
            if cid:
                return cid
        except Exception:
            pass

    # 2) Any room_id in schedule_entries
    entries = doc.get("schedule_entries")
    if isinstance(entries, list):
        for e in entries:
            if not isinstance(e, dict):
                continue
            rid = _safe_str(e.get("room_id") or e.get("roomId"))
            if not rid:
                continue
            try:
                room = await db[COL_ROOMS].find_one({"room_id": rid}, {"_id": 0, "campus_id": 1}) or {}
                cid = _safe_str(room.get("campus_id")).upper()
                if cid:
                    return cid
            except Exception:
                pass

    return ""


async def _notify_apo_for_specialclass(
    *,
    term_id: str,
    special_id: str,
    course_id: str,
    status: str,
    summary: str,
    campus_id: str = "",
    email_from_user_id: Optional[str] = None,
) -> None:
    """Notify APO (in-app + Gmail) about a Special Class update."""
    try:
        campus_id = _safe_str(campus_id).upper()
        apo_uids = await _apo_user_ids_for_campus(campus_id) if campus_id else []
        if not apo_uids:
            apo_uids = await _all_apo_user_ids()
        if not apo_uids:
            return

        title = "Special Class updated"
        details_lines = ["A Special Class record was updated."]
        if summary:
            details_lines.append(summary)
        if status:
            details_lines.append(f"Status: {status}")
        if campus_id:
            details_lines.append(f"Campus: {campus_id}")
        details = "\n".join([x for x in details_lines if x])

        meta: Dict[str, Any] = {
            "route": "/apo/courseofferings",
            "kind": "special_class_updated",
            "term_id": term_id,
            "special_id": special_id,
            "course_id": course_id,
            "campus_id": campus_id,
        }

        for uid in apo_uids:
            await create_notification(
                user_id=uid,
                title=title,
                details=details,
                meta=meta,
                send_email=True,
                email_from_user_id=email_from_user_id,
            )
    except Exception:
        return

async def _faculty_user_id_from_faculty_id(faculty_id: str) -> str:
    faculty_id = _safe_str(faculty_id)
    if not faculty_id:
        return ""
    prof = await db[COL_FAC_PROFILES].find_one(
        {"faculty_id": faculty_id},
        {"_id": 0, "user_id": 1},
    )
    return _safe_str((prof or {}).get("user_id"))


async def _resolve_faculty_user_for_special_row(doc: Dict[str, Any]) -> Tuple[str, str]:
    """Return (faculty_user_id, faculty_id) for a Special Class row."""
    assignment_id = _safe_str(doc.get("assignment_id") or doc.get("faculty_assignment_id"))
    section_id = _safe_str(doc.get("section_id"))

    faculty_id = ""
    if assignment_id:
        asg = await db[COL_FAC_ASSIGN].find_one(
            {"assignment_id": assignment_id, "is_archived": {"$ne": True}},
            {"_id": 0, "faculty_id": 1},
        )
        faculty_id = _safe_str((asg or {}).get("faculty_id"))

    if not faculty_id and section_id:
        fa = await _latest_faculty_assignment_for_section(section_id)
        faculty_id = _safe_str(fa.get("faculty_id"))

    user_id = await _faculty_user_id_from_faculty_id(faculty_id) if faculty_id else ""
    return user_id, faculty_id


async def _notify_faculty_for_specialclass(
    *,
    faculty_user_id: str,
    kind: str,  # "new" | "update"
    special_id: str,
    summary: str,
    term_id: str,
) -> None:
    faculty_user_id = _safe_str(faculty_user_id)
    special_id = _safe_str(special_id)
    term_id = _safe_str(term_id)
    if not faculty_user_id or not special_id:
        return

    title = "Special Class" if kind == "new" else "Reflected Special Class updated"
    details = summary
    meta = {
        "route": "/faculty/overview",
        "kind": "special_class_reflection",
        "special_id": special_id,
        "term_id": term_id,
        "event": kind,
    }

    # In-app + Gmail
    await create_notification(
        user_id=faculty_user_id,
        title=title,
        details=details,
        meta=meta,
        send_email=True,
    )

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
    "Graduating at the end of this Term and course offered is conflict with other enrolled courses",
    "The course is indicated in the program flowchart as a regular offering for the term but is not offered",
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

async def _role_user_ids_by_name_patterns(patterns: List[str], department_id: str | None = None) -> List[str]:
    """Best-effort role recipient lookup across multiple schema variants."""
    pats = [p for p in (patterns or []) if _safe_str(p)]
    dept_id = _safe_str(department_id)
    if not pats:
        return []

    recipients: set[str] = set()
    ra_matchers: List[Dict[str, Any]] = []

    for p in pats:
        regex = {"$regex": p, "$options": "i"}
        ra_matchers.extend([
            {"role": regex},
            {"role_name": regex},
            {"role_title": regex},
            {"role_code": regex},
        ])

    ra_filter: Dict[str, Any] = {"$or": ra_matchers}
    if dept_id:
        ra_filter = {
            "$and": [
                ra_filter,
                {
                    "$or": [
                        {"department_id": dept_id},
                        {"dept_id": dept_id},
                        {"scope": {"$exists": True}},
                    ]
                },
            ]
        }

    try:
        ras = await db["role_assignments"].find(
            ra_filter,
            {"_id": 0, "user_id": 1, "department_id": 1, "dept_id": 1, "scope": 1},
        ).to_list(500)
        for row in ras or []:
            if dept_id:
                dept_match = _safe_str(row.get("department_id")) == dept_id or _safe_str(row.get("dept_id")) == dept_id
                if not (dept_match or _scope_has_department(row.get("scope"), dept_id)):
                    continue
            uid = _safe_str((row or {}).get("user_id"))
            if uid:
                recipients.add(uid)
    except Exception:
        pass

    role_doc_matchers: List[Dict[str, Any]] = []
    for p in pats:
        regex = {"$regex": p, "$options": "i"}
        role_doc_matchers.extend([
            {"name": regex},
            {"role_name": regex},
            {"title": regex},
            {"code": regex},
            {"slug": regex},
        ])

    role_ids: set[str] = set()
    try:
        role_docs = await db["roles"].find(
            {"$or": role_doc_matchers},
            {"_id": 0, "role_id": 1, "id": 1},
        ).to_list(200)
        for row in role_docs or []:
            rid = _safe_str(row.get("role_id") or row.get("id"))
            if rid:
                role_ids.add(rid)
    except Exception:
        pass

    if role_ids:
        try:
            user_role_filter: Dict[str, Any] = {"role_id": {"$in": list(role_ids)}}
            if dept_id:
                user_role_filter = {
                    "$and": [
                        user_role_filter,
                        {
                            "$or": [
                                {"department_id": dept_id},
                                {"dept_id": dept_id},
                                {"scope": {"$exists": True}},
                            ]
                        },
                    ]
                }
            urs = await db["user_roles"].find(
                user_role_filter,
                {"_id": 0, "user_id": 1, "department_id": 1, "dept_id": 1, "scope": 1},
            ).to_list(500)
            for row in urs or []:
                if dept_id:
                    dept_match = _safe_str(row.get("department_id")) == dept_id or _safe_str(row.get("dept_id")) == dept_id
                    if not (dept_match or _scope_has_department(row.get("scope"), dept_id)):
                        continue
                uid = _safe_str((row or {}).get("user_id"))
                if uid:
                    recipients.add(uid)
        except Exception:
            pass

    if recipients:
        return sorted(recipients)

    try:
        users = await db[COL_USERS].find({}, {"_id": 0, "user_id": 1, "role": 1, "role_name": 1, "position": 1, "department_id": 1}).to_list(5000)
        import re
        compiled = [re.compile(p, re.I) for p in pats]
        for u in users or []:
            hay = " ".join([
                _safe_str(u.get("role")),
                _safe_str(u.get("role_name")),
                _safe_str(u.get("position")),
            ])
            if not hay:
                continue
            if dept_id and _safe_str(u.get("department_id")) not in {"", dept_id}:
                continue
            if any(rx.search(hay) for rx in compiled):
                uid = _safe_str(u.get("user_id"))
                if uid:
                    recipients.add(uid)
    except Exception:
        pass

    return sorted(recipients)



def _normalize_day_short(value: Any) -> str:
    raw = _safe_str(value).upper()
    if not raw:
        return ""
    if raw.startswith("TH") or raw == "H":
        return "H"
    c = raw[:1]
    return c if c in {"M", "T", "W", "H", "F", "S"} else ""


def _time_to_minutes(value: Any) -> Optional[int]:
    hhmm = _to_hhmm(value)
    if not hhmm or not _is_valid_hhmm(hhmm):
        return None
    return _mins(hhmm)


def _ranges_overlap(begin_a: int, end_a: int, begin_b: int, end_b: int) -> bool:
    return begin_a < end_b and begin_b < end_a


def _meeting_slots_from_payload(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for suffix in ("1", "2"):
        day = _normalize_day_short(payload.get(f"day{suffix}"))
        begin = _to_hhmm(payload.get(f"begin{suffix}"))
        end = _to_hhmm(payload.get(f"end{suffix}"))
        b = _time_to_minutes(begin)
        e = _time_to_minutes(end)
        if day and b is not None and e is not None and e > b:
            out.append({"day": day, "begin": begin, "end": end, "begin_minutes": b, "end_minutes": e})
    return out


async def _faculty_busy_slots(term_id: str, faculty_ids: List[str]) -> Dict[str, List[Dict[str, str]]]:
    term_id = _safe_str(term_id)
    faculty_ids = [_safe_str(fid) for fid in (faculty_ids or []) if _safe_str(fid)]
    if not term_id or not faculty_ids:
        return {}

    result: Dict[str, List[Dict[str, str]]] = {fid: [] for fid in faculty_ids}

    assignments = await db[COL_FAC_ASSIGN].find(
        {
            "faculty_id": {"$in": faculty_ids},
            "is_archived": {"$ne": True},
        },
        {"_id": 0, "faculty_id": 1, "section_id": 1, "term_id": 1},
    ).to_list(20000)
    if not assignments:
        return result

    section_ids = sorted({ _safe_str(a.get("section_id")) for a in assignments if _safe_str(a.get("section_id")) })
    if not section_ids:
        return result

    valid_section_ids: set[str] = set()
    for a in assignments:
        sid = _safe_str(a.get("section_id"))
        if sid and _safe_str(a.get("term_id")) == term_id:
            valid_section_ids.add(sid)

    try:
        sub_docs = await db[COL_SECTIONS_SUBMITTED].find(
            {"term_id": term_id, "section_id": {"$in": section_ids}},
            {"_id": 0, "section_id": 1},
        ).to_list(20000)
        for sec in sub_docs or []:
            sid = _safe_str(sec.get("section_id"))
            if sid:
                valid_section_ids.add(sid)
    except Exception:
        pass

    try:
        sec_docs = await db[COL_SECTIONS].find(
            {"term_id": term_id, "section_id": {"$in": section_ids}},
            {"_id": 0, "section_id": 1},
        ).to_list(20000)
        for sec in sec_docs or []:
            sid = _safe_str(sec.get("section_id"))
            if sid:
                valid_section_ids.add(sid)
    except Exception:
        pass

    try:
        sched_docs = await db[COL_SECTION_SCHEDULES].find(
            {"term_id": term_id, "section_id": {"$in": section_ids}},
            {"_id": 0, "section_id": 1},
        ).to_list(20000)
        for sched in sched_docs or []:
            sid = _safe_str(sched.get("section_id"))
            if sid:
                valid_section_ids.add(sid)
    except Exception:
        pass

    assignments = [a for a in assignments if _safe_str(a.get("section_id")) in valid_section_ids]
    scoped_section_ids = sorted({ _safe_str(a.get("section_id")) for a in assignments if _safe_str(a.get("section_id")) })
    if not scoped_section_ids:
        return result

    schedules_by_section: Dict[str, List[Dict[str, Any]]] = {}
    sched_cur = db[COL_SECTION_SCHEDULES].find(
        {"section_id": {"$in": scoped_section_ids}},
        {"_id": 0, "section_id": 1, "day": 1, "day_of_week": 1, "start_time": 1, "end_time": 1, "begin": 1, "end": 1},
    )
    async for sched in sched_cur:
        sid = _safe_str(sched.get("section_id"))
        if sid:
            schedules_by_section.setdefault(sid, []).append(sched)

    for asg in assignments:
        fid = _safe_str(asg.get("faculty_id"))
        sid = _safe_str(asg.get("section_id"))
        if not fid or not sid:
            continue
        for sched in schedules_by_section.get(sid, []):
            day = _normalize_day_short(sched.get("day") or sched.get("day_of_week"))
            begin = _to_hhmm(sched.get("start_time") or sched.get("begin"))
            end = _to_hhmm(sched.get("end_time") or sched.get("end"))
            if not day or not begin or not end:
                continue
            result.setdefault(fid, []).append({
                "section_id": sid,
                "day": day,
                "begin": begin,
                "end": end,
            })
    return result


async def _find_faculty_schedule_conflicts(*, term_id: str, faculty_id: str, payload: Dict[str, Any], exclude_section_id: Optional[str] = None, exclude_section_ids: Optional[List[str]] = None) -> List[str]:
    meetings = _meeting_slots_from_payload(payload)
    fid = _safe_str(faculty_id)
    if not term_id or not fid or not meetings:
        return []

    busy_map = await _faculty_busy_slots(term_id, [fid])
    conflicts: List[str] = []
    excluded_ids = { _safe_str(exclude_section_id) } if _safe_str(exclude_section_id) else set()
    for raw in (exclude_section_ids or []):
        sid = _safe_str(raw)
        if sid:
            excluded_ids.add(sid)

    for meeting in meetings:
        for busy in busy_map.get(fid, []):
            sid = _safe_str(busy.get("section_id"))
            if sid and sid in excluded_ids:
                continue
            if _normalize_day_short(busy.get("day")) != meeting["day"]:
                continue
            b = _time_to_minutes(busy.get("begin"))
            e = _time_to_minutes(busy.get("end"))
            if b is None or e is None or e <= b:
                continue
            if _ranges_overlap(meeting["begin_minutes"], meeting["end_minutes"], b, e):
                label = f"{meeting['day']} {_to_hhmm(meeting['begin'])}-{_to_hhmm(meeting['end'])}"
                if label not in conflicts:
                    conflicts.append(label)
    return conflicts


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


async def _special_window_override_for_term(term: Dict[str, Any]) -> Dict[str, Any]:
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


async def _get_allowed_statuses() -> List[str]:
    return OM_ALLOWED_STATUSES

async def _next_special_id() -> str:
    doc = await db[COL_SPECIAL].find_one_and_update(
        {"_id": "config"},
        {"$setOnInsert": {"doc_type": "config"}, "$inc": {"next_seq": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    seq = int((doc or {}).get("next_seq", 1))
    return f"SPCL{seq:04d}"


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


async def _matching_special_group_docs(term_id: str, course_id: str, *, exclude_special_ids: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    term_id = _safe_str(term_id)
    course_id = _safe_str(course_id)
    excludes = {_safe_str(x) for x in (exclude_special_ids or []) if _safe_str(x)}
    if not term_id or not course_id:
        return []

    docs = await db[COL_SPECIAL].find(
        {"term_id": term_id, "course_id": course_id, "special_id": {"$exists": True}},
        {
            "_id": 0,
            "special_id": 1,
            "status": 1,
            "section_id": 1,
            "schedule_id1": 1,
            "schedule_id2": 1,
            "assignment_id": 1,
            "schedule_cleared": 1,
            "faculty_response": 1,
            "faculty_status": 1,
            "faculty_accepted_at": 1,
            "faculty_rejected_at": 1,
            "updated_at": 1,
        },
    ).sort([('updated_at', -1), ('submitted_at', -1)]).to_list(5000)

    out: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for d in docs or []:
        sid = _safe_str((d or {}).get('special_id'))
        if not sid or sid in seen or sid in excludes:
            continue
        seen.add(sid)
        out.append(d or {})
    return out


async def _find_existing_approved_group_binding(term_id: str, course_id: str, *, exclude_special_ids: Optional[List[str]] = None) -> Optional[Dict[str, Any]]:
    docs = await _matching_special_group_docs(term_id, course_id, exclude_special_ids=exclude_special_ids)
    for d in docs:
        if _safe_str(d.get('status')) != 'Approved':
            continue
        section_id = _safe_str(d.get('section_id'))
        assignment_id = _safe_str(d.get('assignment_id'))
        if not section_id and not assignment_id:
            continue
        return {
            'section_id': section_id or None,
            'schedule_id1': _safe_str(d.get('schedule_id1')) or None,
            'schedule_id2': _safe_str(d.get('schedule_id2')) or None,
            'assignment_id': assignment_id or None,
            'schedule_cleared': bool(d.get('schedule_cleared', False)),
            'faculty_response': _safe_str(d.get('faculty_response') or d.get('faculty_status')) or None,
            'faculty_accepted_at': d.get('faculty_accepted_at'),
            'faculty_rejected_at': d.get('faculty_rejected_at'),
        }
    return None


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


async def _binding_from_section(section_id: str) -> Dict[str, Optional[str]]:
    section_id = _safe_str(section_id)
    if not section_id:
        return {"section_id": None, "schedule_id1": None, "schedule_id2": None, "assignment_id": None}
    schedule_id1, schedule_id2 = await _schedule_ids_for_section(section_id)
    assignment = await _latest_faculty_assignment_for_section(section_id)
    return {
        "section_id": section_id,
        "schedule_id1": schedule_id1,
        "schedule_id2": schedule_id2,
        "assignment_id": _safe_str((assignment or {}).get("assignment_id")) or None,
    }


def _norm_room_id(v: Any) -> str:
    s = ("" if v is None else str(v)).strip()
    if not s:
        return ""
    if s.upper() == "ONLINE":
        return ""
    return s


async def _room_lookup_cached(room_id: Optional[str], maps: Dict[str, Any]) -> Dict[str, Any]:
    """
    Returns room info resolved from room_id.
    If missing/unknown -> returns TBA placeholders.
    Uses a per-request cache stored inside maps["roommap"].
    """
    rid = _norm_room_id(room_id)
    if not rid:
        return {"room_id": None, "room_number": "TBA", "capacity": None, "building": "", "campus_id": "", "status": "", "room_type": ""}

    cache = maps.setdefault("roommap", {})
    if rid in cache:
        return cache[rid] or {"room_id": rid, "room_number": "TBA", "capacity": None, "building": "", "campus_id": "", "status": "", "room_type": ""}

    doc = await db[COL_ROOMS].find_one(
        {"room_id": rid},
        {"_id": 0, "room_id": 1, "room_number": 1, "capacity": 1, "building": 1, "campus_id": 1, "status": 1, "room_type": 1},
    )
    if not doc:
        doc = {"room_id": rid, "room_number": "TBA", "capacity": None, "building": "", "campus_id": "", "status": "", "room_type": ""}

    cache[rid] = doc
    return doc


async def _section_schedule_two_from_schedule_ids(
    schedule_id1: Optional[str],
    schedule_id2: Optional[str],
) -> Dict[str, Any]:
    ids = [x for x in [schedule_id1, schedule_id2] if x]
    if not ids:
        return {
            "day1": "",
            "begin1": "",
            "end1": "",
            "room_id1": None,
            "day2": "",
            "begin2": "",
            "end2": "",
            "room_id2": None,
        }

    rows = await db[COL_SECTION_SCHEDULES].find(
        {"schedule_id": {"$in": ids}},
        {"_id": 0, "schedule_id": 1, "day": 1, "start_time": 1, "end_time": 1, "room_id": 1},
    ).to_list(10)

    # keep stable order by schedule_id
    rows.sort(key=lambda r: (r.get("schedule_id") or ""))

    entries: List[Tuple[str, str, str, Optional[str]]] = []
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
        entries.append((d, st, et, r.get("room_id")))

    out: Dict[str, Any] = {
        "day1": "",
        "begin1": "",
        "end1": "",
        "room_id1": None,
        "day2": "",
        "begin2": "",
        "end2": "",
        "room_id2": None,
    }
    if len(entries) >= 1:
        out["day1"], out["begin1"], out["end1"], out["room_id1"] = entries[0]
    if len(entries) >= 2:
        out["day2"], out["begin2"], out["end2"], out["room_id2"] = entries[1]
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
    campus_id = await _department_campus_id_for_course(course_id)

    # --- create section ---
    section_id = await _next_seq_id(COL_SECTIONS, "section_id", "SEC", 4)
    sec_doc = {
        "section_id": section_id,
        "section_code": section_code,
        "term_id": term_id,
        "course_id": course_id,
        "campus_id": campus_id or None,
        "enrollment_cap": 45,
        "enrolled": 0,
        "batch_number": 0,
        "status": "active",
        "remarks": "SPECIAL CLASS",
        "created_at": now,
        "updated_at": now,
    }
    await db[COL_SECTIONS].insert_one(sec_doc)

    await db[COL_SECTIONS_SUBMITTED].insert_one({
        "section_id": section_id,
        "term_id": term_id,
        "course_id": course_id,
        "section_code": section_code,
        "submitted_for_scheduling": True,

        "campus_id": campus_id or "",
        "mode": "HYB", 
        "enrollment_cap": 45,
        "batch_number": 0,
        "remarks": "SPECIAL CLASS",

        "created_at": now,
        "updated_at": now,
    })

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


async def _update_existing_special_section_bundle(
    *,
    section_id: str,
    term_id: str,
    course_id: str,
    section_code: str,
    sched: Dict[str, str],
    faculty_id: str,
) -> Dict[str, Optional[str]]:
    section_id = _safe_str(section_id)
    section_code = _safe_str(section_code).upper()
    faculty_id = _safe_str(faculty_id)
    if not section_id:
        raise HTTPException(status_code=400, detail="section_id is required.")
    if not section_code:
        raise HTTPException(status_code=400, detail="section_code is required for special class schedule.")
    if not faculty_id:
        raise HTTPException(status_code=400, detail="faculty_id is required for special class schedule.")
    if not (sched.get("day1") and sched.get("begin1") and sched.get("end1")):
        raise HTTPException(status_code=400, detail="Meeting 1 is required.")

    now = datetime.utcnow()

    await db[COL_SECTIONS].update_one(
        {"section_id": section_id},
        {"$set": {
            "section_code": section_code,
            "term_id": term_id,
            "course_id": course_id,
            "remarks": "SPECIAL CLASS",
            "updated_at": now,
        }},
    )

    await db[COL_SECTIONS_SUBMITTED].update_one(
        {"section_id": section_id},
        {"$set": {
            "section_code": section_code,
            "term_id": term_id,
            "course_id": course_id,
            "submitted_for_scheduling": True,
            "remarks": "SPECIAL CLASS",
            "updated_at": now,
        }},
        upsert=True,
    )

    def _hhmm_to_db(hhmm: str) -> str:
        s = _to_hhmm(hhmm)
        if not s:
            return ""
        try:
            return str(int(s))
        except Exception:
            return s

    try:
        sec_num = int(section_id.replace("SEC", ""))
    except Exception:
        sec_num = 0
    sch_base = f"SCH{sec_num:04d}"
    schedule_id1 = f"{sch_base}-01"
    schedule_id2 = f"{sch_base}-02"

    await db[COL_SECTION_SCHEDULES].update_one(
        {"section_id": section_id, "schedule_id": schedule_id1},
        {"$set": {
            "schedule_id": schedule_id1,
            "section_id": section_id,
            "term_id": term_id,
            "day": sched["day1"],
            "start_time": _hhmm_to_db(sched["begin1"]),
            "end_time": _hhmm_to_db(sched["end1"]),
            "room_id": None,
            "room_type": "Online",
            "updated_at": now,
        }, "$setOnInsert": {"created_at": now}},
        upsert=True,
    )

    if sched.get("day2") and sched.get("begin2") and sched.get("end2"):
        await db[COL_SECTION_SCHEDULES].update_one(
            {"section_id": section_id, "schedule_id": schedule_id2},
            {"$set": {
                "schedule_id": schedule_id2,
                "section_id": section_id,
                "term_id": term_id,
                "day": sched["day2"],
                "start_time": _hhmm_to_db(sched["begin2"]),
                "end_time": _hhmm_to_db(sched["end2"]),
                "room_id": None,
                "room_type": "Online",
                "updated_at": now,
            }, "$setOnInsert": {"created_at": now}},
            upsert=True,
        )
    else:
        await db[COL_SECTION_SCHEDULES].delete_many({"section_id": section_id, "schedule_id": schedule_id2})
        schedule_id2 = None

    existing_asg = await db[COL_FAC_ASSIGN].find_one(
        {"section_id": section_id, "is_archived": {"$ne": True}},
        {"_id": 0, "assignment_id": 1},
    ) or {}
    assignment_id = _safe_str(existing_asg.get("assignment_id")) or await _next_seq_id(COL_FAC_ASSIGN, "assignment_id", "ASG", 4)
    load_id = await _maybe_load_id_for_faculty(term_id, faculty_id)
    await db[COL_FAC_ASSIGN].update_one(
        {"assignment_id": assignment_id},
        {"$set": {
            "assignment_id": assignment_id,
            "load_id": load_id,
            "section_id": section_id,
            "faculty_id": faculty_id,
            "is_archived": False,
            "updated_at": now,
        }, "$setOnInsert": {"created_at": now}},
        upsert=True,
    )

    return {
        "section_id": section_id,
        "schedule_id1": schedule_id1,
        "schedule_id2": schedule_id2,
        "assignment_id": assignment_id,
    }


async def _regularize_special_section_bundle(*, section_id: str, term_id: str, course_id: str) -> None:
    """Make a reflected Special Class section behave like a regular class section.

    We keep the existing section/schedule/faculty assignment bindings intact and only
    remove the Special Class remark so downstream schedule views stop treating the
    reflected section as a special-class-specific artifact.
    We also backfill key section snapshot fields so APO/OM regular grids can see the
    section immediately after conversion.
    """
    section_id = _safe_str(section_id)
    term_id = _safe_str(term_id)
    course_id = _safe_str(course_id)
    if not section_id:
        return

    now = datetime.utcnow()
    snap = await _regularization_snapshot(section_id, course_id)

    sec_set: Dict[str, Any] = {
        "term_id": term_id or None,
        "course_id": course_id or None,
        "updated_at": now,
        "status": "active",
        "remarks": "REGULAR CLASS",
    }
    sub_set: Dict[str, Any] = {
        "term_id": term_id or None,
        "course_id": course_id or None,
        "submitted_for_scheduling": True,
        "updated_at": now,
        "remarks": "REGULAR CLASS",
        "status": "active",
    }

    if snap.get("section_code"):
        sec_set["section_code"] = snap["section_code"]
        sub_set["section_code"] = snap["section_code"]
    if snap.get("campus_id"):
        sec_set["campus_id"] = snap["campus_id"]
        sub_set["campus_id"] = snap["campus_id"]
    if snap.get("mode"):
        sub_set["mode"] = snap["mode"]
    if snap.get("enrollment_cap") is not None:
        sec_set["enrollment_cap"] = snap["enrollment_cap"]
        sub_set["enrollment_cap"] = snap["enrollment_cap"]
    if snap.get("batch_number") is not None:
        sec_set["batch_number"] = snap["batch_number"]
        sub_set["batch_number"] = snap["batch_number"]

    await db[COL_SECTIONS].update_one(
        {"section_id": section_id},
        {"$set": sec_set},
        upsert=True,
    )

    await db[COL_SECTIONS_SUBMITTED].update_one(
        {"section_id": section_id},
        {"$set": sub_set},
        upsert=True,
    )


def _special_class_conversion_notification(summary: str) -> tuple[str, str]:
    summary = _safe_str(summary) or "This special class"
    title = "Special Class converted to Regular Class"
    details = f"{summary} has been converted to a regular class."
    return title, details


async def _section_schedule_two(section_id: str) -> Dict[str, Any]:
    rows = await db[COL_SECTION_SCHEDULES].find(
        {"section_id": section_id},
        {"_id": 0, "day": 1, "start_time": 1, "end_time": 1, "room_id": 1},
    ).to_list(50)

    entries: List[Tuple[str, str, str, Optional[str]]] = []
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
        entries.append((d, st, et, r.get("room_id")))

    entries.sort(key=lambda x: (DAY_ORDER.get(x[0], 99), x[1]))
    entries = entries[:2]

    out: Dict[str, Any] = {
        "day1": "",
        "begin1": "",
        "end1": "",
        "room_id1": None,
        "day2": "",
        "begin2": "",
        "end2": "",
        "room_id2": None,
    }
    if len(entries) >= 1:
        out["day1"], out["begin1"], out["end1"], out["room_id1"] = entries[0]
    if len(entries) >= 2:
        out["day2"], out["begin2"], out["end2"], out["room_id2"] = entries[1]
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


async def _build_room_options():
    rooms = await db[COL_ROOMS].find(
        {"is_archived": {"$ne": True}},
        {
            "_id": 0,
            "room_id": 1,
            "room_number": 1,
            "capacity": 1,
            "building": 1,
            "campus_id": 1,
            "status": 1,
            "room_type": 1,
        },
    ).to_list(20000)
    rooms.sort(key=lambda r: (r.get("room_number") or "", r.get("room_id") or ""))
    return rooms


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
    term_ids = sorted({(r.get("term_id") or "").strip() for r in rows if r.get("term_id")})

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

    approved_group_bindings: Dict[Tuple[str, str], Dict[str, Any]] = {}
    if term_ids and cids:
        approved_docs = await db[COL_SPECIAL].find(
            {"term_id": {"$in": term_ids}, "course_id": {"$in": cids}, "status": "Approved"},
            {"_id": 0, "term_id": 1, "course_id": 1, "section_id": 1, "schedule_id1": 1, "schedule_id2": 1, "assignment_id": 1, "schedule_cleared": 1, "faculty_response": 1, "faculty_status": 1, "faculty_accepted_at": 1, "faculty_rejected_at": 1, "updated_at": 1},
        ).sort([("updated_at", -1), ("submitted_at", -1)]).to_list(20000)
        for doc in approved_docs or []:
            term_id = _safe_str(doc.get("term_id"))
            course_id = _safe_str(doc.get("course_id"))
            if not term_id or not course_id:
                continue
            key = (term_id, course_id)
            if key in approved_group_bindings:
                continue
            approved_group_bindings[key] = {
                "section_id": _safe_str(doc.get("section_id")) or None,
                "schedule_id1": _safe_str(doc.get("schedule_id1")) or None,
                "schedule_id2": _safe_str(doc.get("schedule_id2")) or None,
                "assignment_id": _safe_str(doc.get("assignment_id")) or None,
                "schedule_cleared": bool(doc.get("schedule_cleared", False)),
                "faculty_response": _safe_str(doc.get("faculty_response") or doc.get("faculty_status")),
                "faculty_accepted_at": doc.get("faculty_accepted_at"),
                "faculty_rejected_at": doc.get("faculty_rejected_at"),
            }
            sid = _safe_str(doc.get("section_id"))
            if sid and sid not in sids:
                sids.append(sid)

    if sids:
        sections = await db[COL_SECTIONS].find(
            {"section_id": {"$in": sorted(set(sids))}},
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

    # roommap is a per-request lazy cache (filled on-demand by _room_lookup_cached)
    return {"umap": umap, "pmap": pmap, "dmap": dmap, "cmap": cmap, "smap": smap, "roommap": {}, "approved_group_bindings": approved_group_bindings}


async def _shape_row(r: Dict[str, Any], maps: Dict[str, Any]) -> Dict[str, Any]:
    uid = (r.get("user_id") or r.get("userId") or "").strip()
    pid = (r.get("program_id") or r.get("programId") or "").strip()
    did = (r.get("department_id") or r.get("departmentId") or "").strip()
    cid = (r.get("course_id") or r.get("courseId") or "").strip()
    sid = (r.get("section_id") or "").strip() or None

    status = (r.get("status") or "").strip()
    binding = (maps.get("approved_group_bindings") or {}).get((_safe_str(r.get("term_id")), cid)) if cid else None
    if (
        (not bool(r.get("generated_from_class_retention")))
        and binding
        and (_safe_str(status) != "Approved")
        and (not bool(r.get("unassigned_by_admin")))
        and (_safe_str(status) not in {"Rejected", "Convert to Regular Class", "Forwarded To Department"})
    ):
        if not sid:
            sid = _safe_str(binding.get("section_id")) or None
        if not _safe_str(r.get("assignment_id") or r.get("faculty_assignment_id")) and binding.get("assignment_id"):
            r = {**r, "assignment_id": binding.get("assignment_id")}
        if not _safe_str(r.get("schedule_id1")) and binding.get("schedule_id1"):
            r = {**r, "schedule_id1": binding.get("schedule_id1")}
        if not _safe_str(r.get("schedule_id2")) and binding.get("schedule_id2"):
            r = {**r, "schedule_id2": binding.get("schedule_id2")}
        if not bool(r.get("schedule_cleared", False)) and bool(binding.get("schedule_cleared", False)):
            r = {**r, "schedule_cleared": True}
        # keep the student's actual workflow status; only inherit the shared binding for display

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

    section_code = (_safe_str(s.get("section_code")) or _safe_str(r.get("section_code")) or "")

    # schedule is derived by IDs (schedule_id1/2) if present, else by section_id
    # NOTE: When schedule_cleared is true, we intentionally show blank schedule even if section has schedules.
    schedule_cleared = bool(r.get("schedule_cleared", False))

    schedule_id1 = (r.get("schedule_id1") or "").strip() or None
    schedule_id2 = (r.get("schedule_id2") or "").strip() or None

    if schedule_cleared:
        df = {
            "day1": "",
            "begin1": "",
            "end1": "",
            "room_id1": None,
            "day2": "",
            "begin2": "",
            "end2": "",
            "room_id2": None,
        }
    elif schedule_id1 or schedule_id2:
        df = await _section_schedule_two_from_schedule_ids(schedule_id1, schedule_id2)
    elif sid:
        df = await _section_schedule_two(sid)
    else:
        # backward-compat only (old rows)
        df = {
            "day1": _normalize_day(r.get("day1")),
            "begin1": _to_hhmm(r.get("begin1")),
            "end1": _to_hhmm(r.get("end1")),
            "room_id1": None,
            "day2": _normalize_day(r.get("day2")),
            "begin2": _to_hhmm(r.get("begin2")),
            "end2": _to_hhmm(r.get("end2")),
            "room_id2": None,
        }

    rid1 = df.get("room_id1")
    rid2 = df.get("room_id2")

    room1 = await _room_lookup_cached(rid1, maps)
    room2 = await _room_lookup_cached(rid2, maps)

    # faculty derived by assignment_id first; fallback to latest assignment for section
    assignment_id = (r.get("assignment_id") or r.get("faculty_assignment_id") or "").strip() or None
    generated_from_class_retention = bool(r.get("generated_from_class_retention"))

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
        # NEW: room display fields (READ-ONLY; UI should display room_number, default TBA)
        "room_id1": _norm_room_id(room1.get("room_id")),
        "room1": room1.get("room_number") or "TBA",
        "room1_building": room1.get("building") or "",
        "room1_capacity": room1.get("capacity"),
        "room1_room_type": room1.get("room_type") or "",
        "room_id2": _norm_room_id(room2.get("room_id")),
        "room2": room2.get("room_number") or "TBA",
        "room2_building": room2.get("building") or "",
        "room2_capacity": room2.get("capacity"),
        "room2_room_type": room2.get("room_type") or "",
        "submitted_at": r.get("submitted_at"),
        "updated_at": r.get("updated_at"),
        "department_id": did,
        "department_name": d.get("department_name") or d.get("dept_name") or "",
        "course_units": course_units,
        "units_remaining": r.get("units_remaining", ""),
        "graduating_after_term": bool(r.get("graduating_after_term", False)),
        "schedule_text": r.get("schedule_text", ""),
        "has_eaf": _eaf_available(r),
        "eaf_original_name": r.get("eaf_original_name") or "",
        "eaf_content_type": r.get("eaf_content_type") or "",
        "eaf_size": r.get("eaf_size") or 0,
        "eaf_uploaded_at": r.get("eaf_uploaded_at"),
        "generated_from_class_retention": generated_from_class_retention,
        "manual_special_class": bool(r.get("manual_special_class")),
        "retention_id": _safe_str(r.get("retention_id")),
        "eaf_view_url": _build_admin_eaf_view_url("om", r.get("special_id") or ""),
    }


async def _resolve_special_course(payload: Dict[str, Any]) -> Dict[str, Any]:
    course_id = _safe_str(payload.get("course_id") or payload.get("courseId"))
    course_code = _safe_str(payload.get("course_code") or payload.get("courseCode"))

    query: Dict[str, Any]
    if course_id:
        query = {"course_id": course_id}
    elif course_code:
        query = {"$or": [{"course_code": course_code}, {"course_code": {"$in": [course_code]}}]}
    else:
        raise HTTPException(status_code=400, detail="course_id or course_code is required.")

    course = await db[COL_COURSES].find_one(
        query,
        {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1, "department_id": 1, "units": 1},
    ) or {}
    if not course:
        raise HTTPException(status_code=404, detail="Course not found.")
    return course


async def _sync_generated_special_classes_from_retention(term_id: str) -> None:
    term_id = _safe_str(term_id)
    if not term_id:
        return

    rows = await db[COL_CLASS_RETENTION].find(
        {"term_id": term_id},
        {"_id": 1, "course_id": 1, "section_id": 1, "section_code": 1, "status": 1},
    ).to_list(5000)

    keep_ids: List[str] = []
    for row in rows or []:
        rid = _safe_str(row.get("_id"))
        if not _is_convert_to_special_status(row.get("status")):
            continue
        course_id = _safe_str(row.get("course_id"))
        section_id = _safe_str(row.get("section_id"))
        section_code = _safe_str(row.get("section_code"))
        if not rid or not course_id:
            continue
        keep_ids.append(rid)
        course = await db[COL_COURSES].find_one(
            {"course_id": course_id},
            {"_id": 0, "department_id": 1},
        ) or {}
        dept_id = _safe_str(course.get("department_id"))
        now = datetime.utcnow()
        generated_special_id = f"CRSC{rid.upper()}"
        binding = await _binding_from_section(section_id) if section_id else {
            "section_id": None,
            "schedule_id1": None,
            "schedule_id2": None,
            "assignment_id": None,
        }
        base_set = {
            "term_id": term_id,
            "course_id": course_id,
            "department_id": dept_id,
            "section_id": binding.get("section_id") or None,
            "section_code": section_code,
            "updated_at": now,
            "generated_from_class_retention": True,
            "retention_id": rid,
            "generated_source_status": "Convert to Special Class",
            "schedule_cleared": False,
            "schedule_id1": binding.get("schedule_id1"),
            "schedule_id2": binding.get("schedule_id2"),
            "assignment_id": binding.get("assignment_id"),
        }
        existing = await db[COL_SPECIAL].find_one(
            {
                "$or": [
                    {"generated_from_class_retention": True, "retention_id": rid},
                    {"special_id": generated_special_id},
                ]
            },
            {"_id": 1, "special_id": 1},
        )
        if existing:
            await db[COL_SPECIAL].update_one(
                {"_id": existing["_id"]},
                {"$set": base_set},
            )
        else:
            insert_doc = {
                "special_id": generated_special_id,
                "user_id": "",
                "student_user_id": "",
                "student_number": "",
                "reason": "Class Retention Conversion",
                "reason_other": "",
                "status": "Forwarded To Department",
                "remarks": "",
                "submitted_at": now,
                "created_at": now,
                **base_set,
            }
            try:
                await db[COL_SPECIAL].insert_one(insert_doc)
            except DuplicateKeyError:
                await db[COL_SPECIAL].update_one(
                    {"special_id": generated_special_id},
                    {"$set": base_set},
                )

    cleanup_query: Dict[str, Any] = {"term_id": term_id, "generated_from_class_retention": True}
    if keep_ids:
        cleanup_query["retention_id"] = {"$nin": keep_ids}
    await db[COL_SPECIAL].delete_many(cleanup_query)


async def _create_manual_special_class_row(term_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    payload = payload or {}
    course = await _resolve_special_course(payload)
    course_id = _safe_str(course.get("course_id"))
    if not course_id:
        raise HTTPException(status_code=400, detail="Resolved course is missing course_id.")

    allowed = set(await _get_allowed_statuses())
    status = _safe_str(payload.get("status")) or "Forwarded To Department"
    if allowed and status not in allowed:
        raise HTTPException(status_code=400, detail="Invalid status value.")

    special_id = await _next_special_id()
    now = datetime.utcnow()

    doc: Dict[str, Any] = {
        "special_id": special_id,
        "term_id": term_id,
        "user_id": "",
        "course_id": course_id,
        "department_id": _safe_str(course.get("department_id")),
        "status": status,
        "remarks": _safe_str(payload.get("remarks")),
        "manual_special_class": True,
        "submitted_at": now,
        "updated_at": now,
        "student_number": None,
        "reason": "",
        "reason_other": "",
        "units_remaining": "",
        "graduating_after_term": False,
        "course_units": course.get("units") or "",
        "section_id": None,
        "schedule_id1": None,
        "schedule_id2": None,
        "assignment_id": None,
        "schedule_cleared": False,
    }

    has_custom_schedule_fields = any(
        payload.get(k) not in (None, "", [], {})
        for k in ["section_code", "faculty_id", "day1", "begin1", "end1", "day2", "begin2", "end2"]
    )

    if has_custom_schedule_fields:
        section_code = _safe_str(payload.get("section_code")).upper()
        faculty_id = _safe_str(payload.get("faculty_id"))
        if not section_code:
            raise HTTPException(status_code=400, detail="section_code is required when adding a class schedule.")
        if not faculty_id:
            raise HTTPException(status_code=400, detail="faculty_id is required when adding a class schedule.")

        sched_valid = _validate_day_fields(payload)
        conflicts = await _find_faculty_schedule_conflicts(
            term_id=term_id,
            faculty_id=faculty_id,
            payload=sched_valid,
            exclude_section_ids=[],
        )
        if conflicts:
            raise HTTPException(status_code=400, detail=f"Faculty already has an assigned schedule at: {', '.join(conflicts)}")

        created = await _create_custom_section_bundle(
            term_id=term_id,
            course_id=course_id,
            section_code=section_code,
            sched=sched_valid,
            faculty_id=faculty_id,
        )
        doc["section_id"] = created.get("section_id")
        doc["schedule_id1"] = created.get("schedule_id1")
        doc["schedule_id2"] = created.get("schedule_id2")
        doc["assignment_id"] = created.get("assignment_id")

    await db[COL_SPECIAL].insert_one(doc)
    return doc


async def _eligible_special_class_students(term_id: str, target_special_id: str) -> List[Dict[str, Any]]:
    target = await db[COL_SPECIAL].find_one(
        {"term_id": term_id, "special_id": target_special_id},
        {"_id": 0, "course_id": 1},
    ) or {}
    course_id = _safe_str(target.get("course_id"))
    if not course_id:
        raise HTTPException(status_code=404, detail="Target special class not found.")

    docs = await db[COL_SPECIAL].find(
        {
            "term_id": term_id,
            "course_id": course_id,
            "special_id": {"$ne": target_special_id},
            "user_id": {"$exists": True, "$nin": ["", None]},
            "manual_special_class": {"$ne": True},
            "generated_from_class_retention": {"$ne": True},
            "status": {"$nin": ["Convert to Regular Class", "Rejected"]},
            "$or": [
                {"section_id": {"$exists": False}},
                {"section_id": None},
                {"section_id": ""},
            ],
        },
        {"_id": 0, "special_id": 1, "user_id": 1, "student_number": 1, "status": 1},
    ).to_list(5000)

    user_ids = [_safe_str(d.get("user_id")) for d in docs if _safe_str(d.get("user_id"))]
    users = await db[COL_USERS].find(
        {"user_id": {"$in": user_ids}},
        {"_id": 0, "user_id": 1, "first_name": 1, "firstName": 1, "last_name": 1, "lastName": 1},
    ).to_list(5000)
    umap = {_safe_str(u.get("user_id")): u for u in users}

    rows: List[Dict[str, Any]] = []
    for d in docs:
        uid = _safe_str(d.get("user_id"))
        u = umap.get(uid) or {}
        rows.append({
            "special_id": _safe_str(d.get("special_id")),
            "student_name": _upper_name(
                u.get("first_name") or u.get("firstName") or "",
                u.get("last_name") or u.get("lastName") or "",
            ),
            "student_number": d.get("student_number"),
            "status": _safe_str(d.get("status")),
        })

    rows.sort(key=lambda r: (str(r.get("student_name") or ""), str(r.get("student_number") or "")))
    return rows



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


def _wrap_text_lines(c, text: str, font: str, size: int, max_w: float) -> List[str]:
    """Word-wrap `text` into lines that fit `max_w` using the given font+size.
    Preserves explicit newlines as hard breaks.
    """
    t = "" if text is None else str(text).strip()
    if not t:
        return []

    out: List[str] = []
    for para in t.split("\n"):
        para = para.strip()
        if not para:
            out.append("")
            continue
        words = para.split()
        cur = ""
        for wrd in words:
            cand = (cur + " " + wrd).strip()
            if c.stringWidth(cand, font, size) <= max_w:
                cur = cand
            else:
                if cur:
                    out.append(cur)
                    cur = wrd
                else:
                    # extremely long single token; fall back to emitting it
                    out.append(wrd)
                    cur = ""
        if cur:
            out.append(cur)
    return out

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

    # Layout: fixed font size for all options, wrap text, and allocate vertical space per option
    option_font = "Helvetica"
    option_size = 9
    leading = option_size * 1.05
    cb_size = 12

    pad_x = 12
    pad_top = 10
    pad_bottom = 8
    gap_x = 8
    gap_y = 2

    cb_x = rx + pad_x
    text_x = cb_x + cb_size + gap_x
    max_w = rw - (pad_x * 2 + cb_size + gap_x)

    y_cursor = reason_top - pad_top  # top edge of content area
    bottom_limit = (reason_top - reason_h) + pad_bottom

    c.setFillColor(BLACK)
    for i, label in enumerate(REASON_LINES):
        lines = _wrap_text_lines(c, label, option_font, option_size, max_w)
        if not lines:
            lines = [""]

        text_h = len(lines) * leading
        block_h = max(cb_size, text_h)

        # If we're going to overflow the box, tighten spacing slightly (last-resort)
        if (y_cursor - block_h) < bottom_limit and gap_y > 0:
            gap_y = 1

        cb_y = y_cursor - cb_size  # top-aligned with the text block
        _draw_checkbox(c, cb_x, cb_y, size=cb_size, checked=(i == idx))

        c.setFont(option_font, option_size)
        # Draw text with its top aligned to y_cursor
        baseline0 = y_cursor - option_size
        for li, line in enumerate(lines):
            c.drawString(text_x, baseline0 - li * leading, line)

        # Move cursor down; don't add extra gap after last option
        y_cursor -= block_h
        if i < len(REASON_LINES) - 1:
            y_cursor -= gap_y

    # Render "Others" free text just below the "Others (please specify)" option (inside the box)
    if idx == 3 and (r.get("reason_other") or "").strip():
        other_text = (r.get("reason_other") or "").strip()
        other_font = "Helvetica-Oblique"
        other_size = 9
        other_leading = other_size * 1.05

        # small separation from the option row
        y_cursor -= 2

        other_lines = _wrap_text_lines(c, other_text, other_font, other_size, max_w)
        c.setFont(other_font, other_size)

        baseline0 = y_cursor - other_size
        for li, line in enumerate(other_lines):
            yy = baseline0 - li * other_leading
            if yy < bottom_limit + 2:
                break  # keep inside the reason box
            c.drawString(text_x, yy, line)
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
    sub_div_x = right_x1 - strip_w  # noqa: F841 (kept for layout parity / future tweaks)

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
async def _delete_special_class_group(term_id: str, special_id: str) -> Dict[str, Any]:
    term_id = _safe_str(term_id)
    special_id = _safe_str(special_id)
    if not term_id or not special_id:
        raise HTTPException(status_code=400, detail="term_id and special_id are required.")

    target = await db[COL_SPECIAL].find_one({"term_id": term_id, "special_id": special_id}, {"_id": 0}) or {}
    if not target:
        raise HTTPException(status_code=404, detail="Special Class row not found.")

    section_id = _safe_str(target.get("section_id"))
    retention_id = _safe_str(target.get("retention_id"))
    course_id = _safe_str(target.get("course_id"))
    is_generated = bool(target.get("generated_from_class_retention"))
    is_manual = bool(target.get("manual_special_class"))

    if section_id:
        group_docs = await db[COL_SPECIAL].find({"term_id": term_id, "section_id": section_id}, {"_id": 0}).to_list(5000)
    elif is_generated and retention_id:
        group_docs = await db[COL_SPECIAL].find(
            {"term_id": term_id, "generated_from_class_retention": True, "retention_id": retention_id},
            {"_id": 0},
        ).to_list(5000)
    else:
        group_docs = [target]

    if not group_docs:
        group_docs = [target]

    applicant_docs = [
        d for d in group_docs
        if not bool(d.get("manual_special_class"))
        and not bool(d.get("generated_from_class_retention"))
        and _safe_str(d.get("user_id"))
    ]
    applicant_ids = [_safe_str(d.get("special_id")) for d in applicant_docs if _safe_str(d.get("special_id"))]
    anchor_ids = [
        _safe_str(d.get("special_id")) for d in group_docs
        if (bool(d.get("manual_special_class")) or bool(d.get("generated_from_class_retention")) or not _safe_str(d.get("user_id")))
        and _safe_str(d.get("special_id"))
    ]

    now = datetime.utcnow()
    cleared_students = 0
    deleted_rows = 0
    kept_row = False

    if applicant_ids:
        res = await db[COL_SPECIAL].update_many(
            {"term_id": term_id, "special_id": {"$in": applicant_ids}},
            {
                "$set": {
                    "section_id": None,
                    "schedule_id1": None,
                    "schedule_id2": None,
                    "assignment_id": None,
                    "schedule_cleared": False,
                    "status": "Forwarded To Department",
                    "updated_at": now,
                },
                "$unset": {
                    "faculty_assignment_id": "",
                    "day1": "",
                    "begin1": "",
                    "end1": "",
                    "day2": "",
                    "begin2": "",
                    "end2": "",
                    "faculty_id": "",
                    "faculty_name": "",
                    "section_code": "",
                    "room_id1": "",
                    "room_id2": "",
                    "room1": "",
                    "room2": "",
                },
            },
        )
        cleared_students = int(res.modified_count)
        kept_row = True

    if is_generated:
        await db[COL_SPECIAL].update_many(
            {"term_id": term_id, "special_id": {"$in": anchor_ids}},
            {
                "$set": {
                    "section_id": None,
                    "section_code": "",
                    "schedule_id1": None,
                    "schedule_id2": None,
                    "assignment_id": None,
                    "schedule_cleared": False,
                    "status": "Forwarded To Department",
                    "updated_at": now,
                },
                "$unset": {
                    "faculty_assignment_id": "",
                    "day1": "",
                    "begin1": "",
                    "end1": "",
                    "day2": "",
                    "begin2": "",
                    "end2": "",
                    "faculty_id": "",
                    "faculty_name": "",
                    "room_id1": "",
                    "room_id2": "",
                    "room1": "",
                    "room2": "",
                },
            },
        )
        kept_row = True
    elif anchor_ids:
        res = await db[COL_SPECIAL].delete_many({"term_id": term_id, "special_id": {"$in": anchor_ids}})
        deleted_rows += int(res.deleted_count)

    if not applicant_ids and not is_generated and not is_manual and special_id:
        res = await db[COL_SPECIAL].delete_one({"term_id": term_id, "special_id": special_id})
        deleted_rows += int(res.deleted_count)

    message = "Special Class deleted."
    if kept_row and applicant_ids:
        message = "Special Class cleared. Students remain under the same course and can be reassigned."
    elif kept_row and is_generated:
        message = "Special Class cleared. The reflected Class Retention row remains visible without schedule/faculty."

    return {
        "ok": True,
        "cleared_students": cleared_students,
        "deleted_rows": deleted_rows,
        "kept_row": kept_row,
        "message": message,
        "course_id": course_id,
    }


@router.get("/specialclass")
async def om_specialclass_get(
    action: str = Query("options", description="options | schedulePresets | eaf"),
    term_id: Optional[str] = Query(None),
    course_id: Optional[str] = Query(None),
    specialId: Optional[str] = Query(None),
):
    if action == "options":
        active = await _active_term()
        statuses = await _get_allowed_statuses()
        faculty = await _build_faculty_options()
        rooms = await _build_room_options()
        course_docs = await db[COL_COURSES].find(
            {},
            {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1},
        ).sort("course_id", ASCENDING).to_list(5000)
        course_options = []
        for course_doc in course_docs or []:
            course_code = course_doc.get("course_code")
            if isinstance(course_code, list):
                course_code = course_code[0] if course_code else ""
            course_options.append({
                "course_id": _safe_str(course_doc.get("course_id")),
                "course_code": _safe_str(course_code),
                "course_title": _safe_str(course_doc.get("course_title")),
            })
        faculty_availability = await _faculty_busy_slots(
            _safe_str((active or {}).get("term_id")),
            [_safe_str(f.get("faculty_id")) for f in (faculty or []) if _safe_str(f.get("faculty_id"))],
        )
        window = await _special_window_override_for_term(active or {})
        return {
            "ok": True,
            "statuses": statuses,
            "activeTerm": {
                "term_id": active.get("term_id", ""),
                "acad_year_start": active.get("acad_year_start"),
                "term_number": active.get("term_number"),
            },
            "facultyOptions": faculty,
            "facultyAvailability": faculty_availability,
            "courseOptions": course_options,
            # note: rooms are returned but UI does NOT need to edit rooms; display comes from list rows
            "roomOptions": rooms,
            "submission_window": {
                "openISO": window.get("openISO") or "",
                "deadlineISO": window.get("deadlineISO") or "",
                "term_id": window.get("term_id"),
            },
        }

    if action == "schedulePresets":
        if not term_id:
            active = await _active_term()
            term_id = active.get("term_id")
        if not term_id or not course_id:
            return {"ok": True, "presets": []}
        presets = await _schedule_presets(term_id, course_id)
        return {"ok": True, "presets": presets}

    if action == "eaf":
        sid = _safe_str(specialId)
        if not sid:
            raise HTTPException(status_code=400, detail="specialId is required.")
        match = {"special_id": sid}
        if term_id:
            match["term_id"] = term_id
        doc = await db[COL_SPECIAL].find_one(
            match,
            {"_id": 0, "eaf_storage_path": 1, "eaf_original_name": 1, "eaf_content_type": 1, "eaf_base64": 1},
        )
        if not doc:
            raise HTTPException(status_code=404, detail="EAF not found.")
        return _inline_eaf_response(doc)

    raise HTTPException(status_code=400, detail="Unsupported action")


# ---------------- routes (POST) ----------------
@router.post("/specialclass")
async def om_specialclass_post(
    action: str = Query("list", description="list | detail | update | bulkUpdate | exportPdf | startWindow"),
    status: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    termId: Optional[str] = Query(None),
    specialId: Optional[str] = Query(None),
    targetSpecialId: Optional[str] = Query(None),
    # Optional: used as Gmail sender for notification emails (best effort).
    userId: Optional[str] = Query(None),
    durationDays: Optional[int] = Query(None),
    openISO: Optional[str] = Query(None, description="(Optional) Exact open datetime in ISO 8601"),
    deadlineISO: Optional[str] = Query(None, description="(Optional) Exact deadline datetime in ISO 8601"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    active = await _active_term()
    current_term_id = termId or active.get("term_id")

    if action in {"list", "detail", "update", "bulkUpdate", "exportPdf", "create", "eligibleStudents", "unassignStudent", "assignStudent", "deleteClass"} and not current_term_id:
        raise HTTPException(status_code=503, detail="No active term configured.")

    if action == "startWindow":
        if termId:
            term_doc = await db[COL_TERMS].find_one(
                {"term_id": termId},
                {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
            )
        else:
            term_doc = active or await _active_term()
        if not term_doc or not term_doc.get("term_id"):
            raise HTTPException(status_code=400, detail="Active term not found; cannot start window.")

        term_id = term_doc["term_id"]

        def _parse_iso_as_utc(s: Optional[str]) -> Optional[datetime]:
            if not s:
                return None
            try:
                dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
            except Exception:
                return None
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)

        open_dt = _parse_iso_as_utc(openISO)
        deadline_dt = _parse_iso_as_utc(deadlineISO)
        if open_dt and deadline_dt:
            if deadline_dt <= open_dt:
                raise HTTPException(status_code=400, detail="deadlineISO must be after openISO.")
        else:
            days = durationDays if durationDays is not None else 7
            try:
                days = int(days)
            except Exception:
                days = 7
            if days <= 0:
                raise HTTPException(status_code=400, detail="durationDays must be a positive integer.")
            now = datetime.now(timezone.utc)
            open_dt = now
            deadline_dt = now + timedelta(days=days)

        await db[COL_SPECIAL_WINDOWS].update_one(
            {"term_id": term_id},
            {
                "$set": {
                    "term_id": term_id,
                    "open_dt": open_dt,
                    "deadline_dt": deadline_dt,
                    "openISO": open_dt.isoformat(),
                    "deadlineISO": deadline_dt.isoformat(),
                    "updated_at": datetime.now(timezone.utc),
                },
                "$setOnInsert": {"created_at": datetime.now(timezone.utc)},
            },
            upsert=True,
        )

        window = await _special_window_override_for_term(term_doc)
        return {
            "ok": True,
            "submission_window": {
                "openISO": window.get("openISO") or "",
                "deadlineISO": window.get("deadlineISO") or "",
                "term_id": window.get("term_id"),
            },
        }

    if action == "create":
        if payload is None:
            raise HTTPException(status_code=400, detail="payload is required.")
        doc = await _create_manual_special_class_row(current_term_id, payload)
        maps = await _bulk_maps_for_rows([doc])
        row = await _shape_row(doc, maps)
        return {"ok": True, "special_id": _safe_str(doc.get("special_id")), "row": row}

    if action == "eligibleStudents":
        target_sid = _safe_str(targetSpecialId or specialId)
        if not target_sid:
            raise HTTPException(status_code=400, detail="targetSpecialId is required.")
        rows = await _eligible_special_class_students(current_term_id, target_sid)
        return {"ok": True, "rows": rows}

    if action == "unassignStudent":
        if not specialId:
            raise HTTPException(status_code=400, detail="specialId is required.")
        doc = await db[COL_SPECIAL].find_one({"term_id": current_term_id, "special_id": specialId}, {"_id": 0}) or {}
        if not doc:
            raise HTTPException(status_code=404, detail="Student application not found.")
        if bool(doc.get("manual_special_class")) or bool(doc.get("generated_from_class_retention")) or not _safe_str(doc.get("user_id")):
            raise HTTPException(status_code=400, detail="Only actual student applications can be removed from a class.")

        res = await db[COL_SPECIAL].update_one(
            {"term_id": current_term_id, "special_id": specialId},
            {
                "$set": {
                    "section_id": None,
                    "schedule_id1": None,
                    "schedule_id2": None,
                    "assignment_id": None,
                    "schedule_cleared": False,
                    "status": "Forwarded To Department",
                    "unassigned_by_admin": True,
                    "updated_at": datetime.utcnow(),
                },
                "$unset": {
                    "faculty_assignment_id": "",
                    "day1": "",
                    "begin1": "",
                    "end1": "",
                    "day2": "",
                    "begin2": "",
                    "end2": "",
                    "faculty_id": "",
                    "faculty_name": "",
                    "section_code": "",
                },
            },
        )
        return {"ok": True, "matched": res.matched_count, "modified": res.modified_count}

    if action == "assignStudent":
        target_sid = _safe_str(targetSpecialId or specialId)
        student_sid = _safe_str((payload or {}).get("studentSpecialId"))
        if not target_sid or not student_sid:
            raise HTTPException(status_code=400, detail="targetSpecialId and studentSpecialId are required.")

        target_doc = await db[COL_SPECIAL].find_one({"term_id": current_term_id, "special_id": target_sid}, {"_id": 0}) or {}
        student_doc = await db[COL_SPECIAL].find_one({"term_id": current_term_id, "special_id": student_sid}, {"_id": 0}) or {}
        if not target_doc or not student_doc:
            raise HTTPException(status_code=404, detail="Special Class row not found.")
        if bool(student_doc.get("manual_special_class")) or bool(student_doc.get("generated_from_class_retention")) or not _safe_str(student_doc.get("user_id")):
            raise HTTPException(status_code=400, detail="Only actual student applications can be assigned.")

        target_course_id = _safe_str(target_doc.get("course_id") or target_doc.get("courseId"))
        student_course_id = _safe_str(student_doc.get("course_id") or student_doc.get("courseId"))
        if not target_course_id or target_course_id != student_course_id:
            raise HTTPException(status_code=400, detail="Student applications can only be assigned within the same course.")

        section_id = _safe_str(target_doc.get("section_id")) or None
        section_code = _safe_str(target_doc.get("section_code"))
        assignment_id = _safe_str(target_doc.get("assignment_id") or target_doc.get("faculty_assignment_id")) or None
        if not section_id and not assignment_id:
            raise HTTPException(status_code=400, detail="Target special class must have a section/faculty schedule before adding students.")

        res = await db[COL_SPECIAL].update_one(
            {"term_id": current_term_id, "special_id": student_sid},
            {
                "$set": {
                    "section_id": section_id or None,
                    "section_code": section_code,
                    "schedule_id1": _safe_str(target_doc.get("schedule_id1")) or None,
                    "schedule_id2": _safe_str(target_doc.get("schedule_id2")) or None,
                    "assignment_id": assignment_id,
                    "schedule_cleared": bool(target_doc.get("schedule_cleared", False)),
                    "status": _safe_str(target_doc.get("status")) or "Forwarded To Department",
                    "updated_at": datetime.utcnow(),
                },
                "$unset": {
                    "unassigned_by_admin": "",
                },
            },
        )
        return {"ok": True, "matched": res.matched_count, "modified": res.modified_count}

    if action == "deleteClass":
        target_sid = _safe_str(targetSpecialId or specialId)
        if not target_sid:
            raise HTTPException(status_code=400, detail="specialId is required.")
        return await _delete_special_class_group(current_term_id, target_sid)

    if action == "list":
        await _sync_generated_special_classes_from_retention(current_term_id)
        await _sync_regularized_special_sections(current_term_id)
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

        # Attach RFC state per special_id so the OM UI can show a red-dot indicator
        # on the Message action when faculty has sent a message and OM needs to respond.
        try:
            special_ids = [rr.get("special_id") for rr in shaped if rr.get("special_id")]
            if special_ids:
                rfc_docs = await db[COL_LOAD_RFC].find(
                    {"term_id": current_term_id, "section_id": {"$in": special_ids}},
                    {"_id": 0, "section_id": 1, "status": 1, "locked": 1, "updated_at": 1},
                ).to_list(20000)

                rfc_map: Dict[str, Dict[str, Any]] = {}
                for rfc in rfc_docs or []:
                    sid = _safe_str(rfc.get("section_id"))
                    if not sid:
                        continue
                    # Keep the most recently updated RFC per section_id.
                    prev = rfc_map.get(sid)
                    if not prev:
                        rfc_map[sid] = rfc
                        continue
                    try:
                        prev_ts = prev.get("updated_at")
                        cur_ts = rfc.get("updated_at")
                        if cur_ts and (not prev_ts or cur_ts > prev_ts):
                            rfc_map[sid] = rfc
                    except Exception:
                        # If timestamps are not comparable, keep the existing one.
                        pass

                for rr in shaped:
                    sid = _safe_str(rr.get("special_id"))
                    rfc = rfc_map.get(sid) if sid else None
                    st = _safe_str((rfc or {}).get("status")).upper()
                    rr["rfc_status"] = st
                    rr["rfc_locked"] = bool((rfc or {}).get("locked"))
                    rr["rfc_needs_om"] = (st == "NEEDS_OM")
            else:
                for rr in shaped:
                    rr["rfc_status"] = ""
                    rr["rfc_locked"] = False
                    rr["rfc_needs_om"] = False
        except Exception:
            # Best-effort only; never block list rendering due to RFC lookups.
            for rr in shaped:
                rr["rfc_status"] = rr.get("rfc_status") or ""
                rr["rfc_locked"] = bool(rr.get("rfc_locked")) if rr.get("rfc_locked") is not None else False
                rr["rfc_needs_om"] = bool(rr.get("rfc_needs_om")) if rr.get("rfc_needs_om") is not None else False

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

        requested_ids: List[str] = []
        if isinstance(payload.get("special_ids"), list):
            for raw_sid in payload.get("special_ids") or []:
                sid = _safe_str(raw_sid)
                if sid and sid not in requested_ids:
                    requested_ids.append(sid)
        if specialId not in requested_ids:
            requested_ids.insert(0, specialId)

        existing_docs = await db[COL_SPECIAL].find(
            {"term_id": current_term_id, "special_id": {"$in": requested_ids}},
            {"_id": 0},
        ).to_list(max(5000, len(requested_ids) * 2))
        if not existing_docs:
            raise HTTPException(status_code=404, detail="Application not found.")

        existing_by_id = { _safe_str(d.get("special_id")): d for d in existing_docs if _safe_str(d.get("special_id")) }
        target_special_ids = [sid for sid in requested_ids if sid in existing_by_id]
        if not target_special_ids:
            raise HTTPException(status_code=404, detail="Application not found.")

        existing_doc_full = existing_by_id.get(specialId) or existing_docs[0]
        prev_status = _safe_str(existing_doc_full.get("status"))
        dept_id_for_notify = _safe_str(
            existing_doc_full.get("department_id")
            or existing_doc_full.get("dept_id")
            or existing_doc_full.get("departmentId")
        )

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
        base_doc = {
            "course_id": existing_doc_full.get("course_id"),
            "courseId": existing_doc_full.get("courseId"),
        }

        course_id_base = (base_doc.get("course_id") or base_doc.get("courseId") or "").strip()
        if not course_id_base:
            raise HTTPException(status_code=400, detail="Missing course_id on special_class record.")

        # ---- schedule binding rules ----
        # [1] If section_id is provided (existing section): store ONLY ids from that section
        # [2] If section_id is null/empty AND custom schedule provided: create docs in 3 tables and store ONLY ids
        # NOTE: rooms are READ-ONLY in OM_SpecialClass UI per your requirement (no room edits).

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

        clear_schedule_only = bool(payload.get("clear_schedule_only", False))

        if clear_schedule_only and req_section_id:
            # Clear ONLY the schedule (day/time) while keeping section & faculty binding.
            # We achieve this by clearing schedule_id1/2 and setting schedule_cleared=true so _shape_row
            # does not re-derive schedule from the section.
            updates_set["section_id"] = req_section_id
            updates_set["schedule_id1"] = None
            updates_set["schedule_id2"] = None
            updates_set["schedule_cleared"] = True

        elif "section_id" in payload and req_section_id:
            # Existing reflected section: if schedule/faculty fields are provided, update the linked bundle in-place.
            sid = req_section_id
            has_custom_schedule_fields = any(
                (payload.get(k) not in (None, "", [], {}))
                for k in ["section_code", "faculty_id", "day1", "begin1", "end1", "day2", "begin2", "end2"]
            )

            if has_custom_schedule_fields:
                sched_valid = _validate_day_fields(payload)
                faculty_id_for_update = _safe_str(payload.get("faculty_id"))
                section_code_for_update = _safe_str(payload.get("section_code"))
                group_section_ids = sorted({
                    _safe_str((d or {}).get("section_id")) for d in (existing_docs or []) if _safe_str((d or {}).get("section_id"))
                })
                conflicts = await _find_faculty_schedule_conflicts(
                    term_id=current_term_id,
                    faculty_id=faculty_id_for_update,
                    payload=sched_valid,
                    exclude_section_id=sid,
                    exclude_section_ids=group_section_ids,
                )
                if conflicts:
                    raise HTTPException(status_code=400, detail=f"Faculty already has an assigned schedule at: {', '.join(conflicts)}")

                updated = await _update_existing_special_section_bundle(
                    section_id=sid,
                    term_id=current_term_id,
                    course_id=course_id_base,
                    section_code=section_code_for_update,
                    sched=sched_valid,
                    faculty_id=faculty_id_for_update,
                )

                updates_set["section_id"] = updated.get("section_id")
                updates_set["schedule_id1"] = updated.get("schedule_id1")
                updates_set["schedule_id2"] = updated.get("schedule_id2")
                updates_set["assignment_id"] = updated.get("assignment_id")
            else:
                sid1, sid2 = await _schedule_ids_for_section(sid)
                fa = await _latest_faculty_assignment_for_section(sid)
                updates_set["section_id"] = sid
                updates_set["schedule_id1"] = sid1
                updates_set["schedule_id2"] = sid2
                updates_set["assignment_id"] = fa.get("assignment_id")

            updates_set["schedule_cleared"] = False

        elif is_custom_request:
            # ✅ CUSTOM path: create docs in sections / section_schedules / faculty_assignments
            section_code = (payload.get("section_code") or "").strip()
            fid = (payload.get("faculty_id") or "").strip()
            sched_valid = _validate_day_fields(payload)
            group_section_ids = sorted({
                _safe_str((d or {}).get("section_id")) for d in (existing_docs or []) if _safe_str((d or {}).get("section_id"))
            })
            conflicts = await _find_faculty_schedule_conflicts(
                term_id=current_term_id,
                faculty_id=fid,
                payload=sched_valid,
                exclude_section_ids=group_section_ids,
            )
            if conflicts:
                raise HTTPException(status_code=400, detail=f"Faculty already has an assigned schedule at: {', '.join(conflicts)}")

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

            updates_set["schedule_cleared"] = False

        elif "section_id" in payload and not req_section_id:
            # clearing ALL binding (section/faculty/schedule) with NO custom data
            updates_set["section_id"] = None
            updates_set["schedule_id1"] = None
            updates_set["schedule_id2"] = None
            updates_set["assignment_id"] = None
            updates_set["schedule_cleared"] = False

        target_status_for_update = _safe_str(updates_set.get("status") or payload.get("status") or prev_status)
        joined_existing_group = False
        if target_status_for_update == "Approved":
            binding = await _find_existing_approved_group_binding(
                current_term_id,
                course_id_base,
                exclude_special_ids=target_special_ids,
            )
            if binding:
                joined_existing_group = True
                updates_set["section_id"] = binding.get("section_id")
                updates_set["schedule_id1"] = binding.get("schedule_id1")
                updates_set["schedule_id2"] = binding.get("schedule_id2")
                updates_set["assignment_id"] = binding.get("assignment_id")
                updates_set["schedule_cleared"] = bool(binding.get("schedule_cleared", False))
                if binding.get("faculty_response"):
                    updates_set["faculty_response"] = binding.get("faculty_response")
                if binding.get("faculty_accepted_at"):
                    updates_set["faculty_accepted_at"] = binding.get("faculty_accepted_at")
                if binding.get("faculty_rejected_at"):
                    updates_set["faculty_rejected_at"] = None

        if not updates_set and not updates_unset:
            return {"ok": False, "message": "Nothing to update."}

        updates_set["updated_at"] = datetime.utcnow()

        res = await db[COL_SPECIAL].update_many(
            {"term_id": current_term_id, "special_id": {"$in": target_special_ids}},
            {"$set": updates_set, "$unset": updates_unset},
        )

        converted_docs: List[Dict[str, Any]] = []
        try:
            if res.modified_count and target_status_for_update == "Convert to Regular Class":
                converted_docs = await db[COL_SPECIAL].find(
                    {"term_id": current_term_id, "special_id": {"$in": target_special_ids}},
                    {
                        "_id": 0,
                        "special_id": 1,
                        "course_id": 1,
                        "courseId": 1,
                        "section_id": 1,
                        "section_code": 1,
                        "assignment_id": 1,
                        "faculty_assignment_id": 1,
                        "user_id": 1,
                        "student_user_id": 1,
                    },
                ).to_list(5000)

                for cd in converted_docs:
                    sec_id = _safe_str(cd.get("section_id"))
                    course_id = _safe_str(cd.get("course_id") or cd.get("courseId") or course_id_base)
                    if sec_id:
                        await _regularize_special_section_bundle(section_id=sec_id, term_id=current_term_id, course_id=course_id)
        except Exception:
            converted_docs = []

        # ---------------- STUDENT notifications ----------------
        # Notify every affected student in the grouped Special Class request.
        # Best-effort only; never block the update endpoint due to notification failures.
        try:
            if res.modified_count and target_status_for_update != "Convert to Regular Class":
                updated_doc = await db[COL_SPECIAL].find_one(
                    {"term_id": current_term_id, "special_id": {"$in": target_special_ids}},
                    {
                        "_id": 0,
                        "status": 1,
                        "remarks": 1,
                        "course_id": 1,
                        "courseId": 1,
                        "section_id": 1,
                        "section_code": 1,
                        "schedule_cleared": 1,
                        "schedule_id1": 1,
                        "schedule_id2": 1,
                        "day1": 1,
                        "begin1": 1,
                        "end1": 1,
                        "day2": 1,
                        "begin2": 1,
                        "end2": 1,
                    },
                ) or {}

                new_status = _safe_str(updated_doc.get("status"))
                new_remarks = _safe_str(updated_doc.get("remarks"))
                course_id = _safe_str(updated_doc.get("course_id") or updated_doc.get("courseId") or course_id_base)
                course_code = ""
                course_title = ""
                if course_id:
                    c = await db[COL_COURSES].find_one({"course_id": course_id}, {"_id": 0, "course_code": 1, "course_title": 1}) or {}
                    cc = c.get("course_code")
                    course_code = _safe_str(cc[0]) if isinstance(cc, list) and cc else _safe_str(cc)
                    course_title = _safe_str(c.get("course_title"))

                section_code = _safe_str(updated_doc.get("section_code"))
                if not section_code:
                    sid = _safe_str(updated_doc.get("section_id"))
                    if sid:
                        sdoc = await db[COL_SECTIONS].find_one({"section_id": sid}, {"_id": 0, "section_code": 1}) or {}
                        section_code = _safe_str(sdoc.get("section_code"))

                schedule_line = ""
                try:
                    schedule_cleared = bool(updated_doc.get("schedule_cleared", False))
                    if not schedule_cleared:
                        sid = _safe_str(updated_doc.get("section_id"))
                        sch1 = _safe_str(updated_doc.get("schedule_id1"))
                        sch2 = _safe_str(updated_doc.get("schedule_id2"))
                        if sch1 or sch2:
                            df = await _section_schedule_two_from_schedule_ids(sch1 or None, sch2 or None)
                        elif sid:
                            df = await _section_schedule_two(sid)
                        else:
                            df = {
                                "day1": _normalize_day(updated_doc.get("day1")),
                                "begin1": _to_hhmm(updated_doc.get("begin1")),
                                "end1": _to_hhmm(updated_doc.get("end1")),
                                "room_id1": None,
                                "day2": _normalize_day(updated_doc.get("day2")),
                                "begin2": _to_hhmm(updated_doc.get("begin2")),
                                "end2": _to_hhmm(updated_doc.get("end2")),
                                "room_id2": None,
                            }
                        schedule_line = (_schedule_line(df) or "").strip()
                except Exception:
                    schedule_line = ""

                title = "Special Class approved" if new_status == "Approved" else "Special Class updated"
                parts = []
                if course_code or course_title:
                    parts.append(f"Course: {course_code} — {course_title}".strip(" —"))
                if section_code:
                    parts.append(f"Section: {section_code}")
                if schedule_line:
                    parts.append(f"Schedule: {schedule_line}")
                if new_status:
                    parts.append(f"Status: {new_status}")
                if new_remarks:
                    parts.append(f"Remarks: {new_remarks}")
                details = "\n".join(parts) if parts else "Your Special Class request was updated."

                student_uids = sorted({
                    _safe_str((d or {}).get("user_id") or (d or {}).get("student_user_id"))
                    for d in (existing_docs or [])
                    if _safe_str((d or {}).get("user_id") or (d or {}).get("student_user_id"))
                })
                for student_uid in student_uids:
                    await create_notification(
                        user_id=student_uid,
                        title=title,
                        details=details,
                        meta={
                            "route": "/student/specialclass",
                            "kind": "student_specialclass_updated",
                            "term_id": current_term_id,
                            "special_id": specialId,
                            "special_ids": target_special_ids,
                            "course_id": course_id,
                        },
                        send_email=True,
                        email_from_user_id=(userId or None),
                    )
        except Exception:
            pass

        # ---------------- CONVERSION notifications ----------------
        try:
            if converted_docs:
                course_ids = list({
                    _safe_str(d.get("course_id") or d.get("courseId") or course_id_base)
                    for d in converted_docs
                    if _safe_str(d.get("course_id") or d.get("courseId") or course_id_base)
                })
                code_map: Dict[str, str] = {}
                if course_ids:
                    cdocs = await db[COL_COURSES].find(
                        {"course_id": {"$in": course_ids}},
                        {"_id": 0, "course_id": 1, "course_code": 1},
                    ).to_list(5000)
                    for c in cdocs or []:
                        cid = _safe_str(c.get("course_id"))
                        cc = c.get("course_code")
                        code_map[cid] = _safe_str(cc[0]) if isinstance(cc, list) and cc else _safe_str(cc)

                student_uids = sorted({
                    _safe_str((d or {}).get("user_id") or (d or {}).get("student_user_id"))
                    for d in converted_docs
                    if _safe_str((d or {}).get("user_id") or (d or {}).get("student_user_id"))
                })

                faculty_uids: set[str] = set()
                labels: List[str] = []
                for d in converted_docs:
                    fac_uid, _ = await _resolve_faculty_user_for_special_row(d)
                    if fac_uid:
                        faculty_uids.add(fac_uid)
                    cid = _safe_str(d.get("course_id") or d.get("courseId") or course_id_base)
                    sid = _safe_str(d.get("special_id"))
                    sec_code = _safe_str(d.get("section_code"))
                    label_parts = [p for p in [code_map.get(cid, cid), sec_code] if p]
                    label = " ".join(label_parts).strip() or (f"Special ID: {sid}" if sid else "Special Class")
                    if label not in labels:
                        labels.append(label)

                summary = labels[0] if len(labels) == 1 else f"{len(labels)} special class request{'s' if len(labels) != 1 else ''}"
                title, details = _special_class_conversion_notification(summary)

                for uid in sorted(faculty_uids):
                    await create_notification(
                        user_id=uid,
                        title=title,
                        details=details,
                        meta={
                            "route": "/faculty/overview",
                            "kind": "special_class_converted_regular",
                            "term_id": current_term_id,
                            "special_ids": [
                                _safe_str(d.get("special_id")) for d in converted_docs if _safe_str(d.get("special_id"))
                            ],
                        },
                        send_email=True,
                        email_from_user_id=(userId or None),
                    )

                for uid in student_uids:
                    await create_notification(
                        user_id=uid,
                        title=title,
                        details=details,
                        meta={
                            "route": "/student/specialclass",
                            "kind": "special_class_converted_regular",
                            "term_id": current_term_id,
                            "special_ids": [
                                _safe_str(d.get("special_id")) for d in converted_docs if _safe_str(d.get("special_id"))
                            ],
                        },
                        send_email=True,
                        email_from_user_id=(userId or None),
                    )
        except Exception:
            pass

        # ---------------- CHAIR notifications ----------------
        # Notify when:
        # - status transitions to Approved (new reflection)
        # - any update while already Approved (update reflection)
        try:
            # Only attempt notifications if we can resolve a department.
            if dept_id_for_notify and res.modified_count:
                updated_doc = await db[COL_SPECIAL].find_one(
                    {"term_id": current_term_id, "special_id": {"$in": target_special_ids}},
                    {"_id": 0, "status": 1, "course_id": 1, "courseId": 1, "section_id": 1, "section_code": 1},
                )
                new_status = _safe_str((updated_doc or {}).get("status"))

                # Build a short summary for notifications.
                course_id = _safe_str((updated_doc or {}).get("course_id") or (updated_doc or {}).get("courseId"))
                course_code = ""
                if course_id:
                    c = await db[COL_COURSES].find_one({"course_id": course_id}, {"_id": 0, "course_code": 1})
                    cc = (c or {}).get("course_code")
                    if isinstance(cc, list) and cc:
                        course_code = _safe_str(cc[0])
                    else:
                        course_code = _safe_str(cc)

                section_code = _safe_str((updated_doc or {}).get("section_code"))
                if not section_code:
                    # derive from sections table if possible
                    sid = _safe_str((updated_doc or {}).get("section_id"))
                    if sid:
                        sdoc = await db[COL_SECTIONS].find_one({"section_id": sid}, {"_id": 0, "section_code": 1})
                        section_code = _safe_str((sdoc or {}).get("section_code"))

                summary_parts = []
                if course_code:
                    summary_parts.append(course_code)
                if section_code:
                    summary_parts.append(section_code)
                summary = " ".join(summary_parts).strip() or f"Special Class {specialId}"

                # --- FACULTY notifications (in-app + Gmail) ---
                # Reflected Special Classes are shown on Faculty calendar + list.
                # Notify the owning faculty when newly reflected, and whenever an already-reflected row is updated.
                try:
                    updated_full = await db[COL_SPECIAL].find_one(
                        {"term_id": current_term_id, "special_id": specialId},
                        {"_id": 0, "assignment_id": 1, "faculty_assignment_id": 1, "section_id": 1},
                    ) or {}
                    fac_uid, _fac_id = await _resolve_faculty_user_for_special_row(updated_full)
                    if fac_uid:
                        if prev_status != "Approved" and new_status == "Approved":
                            await _notify_faculty_for_specialclass(
                                faculty_user_id=fac_uid,
                                kind="new",
                                special_id=specialId,
                                summary=f"An approved Special Class was reflected to your schedule: {summary}",
                                term_id=current_term_id,
                            )
                        elif prev_status == "Approved" and new_status == "Approved":
                            await _notify_faculty_for_specialclass(
                                faculty_user_id=fac_uid,
                                kind="update",
                                special_id=specialId,
                                summary=f"A reflected Special Class in your schedule was updated: {summary}",
                                term_id=current_term_id,
                            )
                except Exception:
                    pass

                if prev_status != "Approved" and new_status == "Approved":
                    await _notify_chairs_for_specialclass(
                        dept_id_for_notify,
                        kind="new",
                        special_id=specialId,
                        summary=f"Approved Special Class in Plantilla: {summary}",
                    )
                elif prev_status == "Approved" and new_status == "Approved":
                    await _notify_chairs_for_specialclass(
                        dept_id_for_notify,
                        kind="update",
                        special_id=specialId,
                        summary=f"Reflected Special Class updated in Plantilla: {summary}",
                    )
        except Exception:
            # Never block the update endpoint due to notification failures.
            pass


        # ---------------- GROUP JOIN notifications ----------------
        try:
            if joined_existing_group and res.modified_count:
                joined_count = len(target_special_ids)
                join_summary = f"{joined_count} student request{'s' if joined_count != 1 else ''} joined an already approved Special Class group."
                fac_uid, _fac_id = await _resolve_faculty_user_for_special_row(existing_doc_full)
                if fac_uid:
                    await _notify_faculty_for_specialclass(
                        faculty_user_id=fac_uid,
                        kind="update",
                        special_id=specialId,
                        summary=join_summary,
                        term_id=current_term_id,
                    )
                for om_uid in await _role_user_ids_by_name_patterns([r"office\s*manager", r"\bom\b"]):
                    await create_notification(
                        user_id=om_uid,
                        title="Special Class group updated",
                        details=join_summary,
                        meta={
                            "route": "/om/special-class",
                            "kind": "special_class_group_join",
                            "term_id": current_term_id,
                            "special_id": specialId,
                            "special_ids": target_special_ids,
                        },
                        send_email=True,
                        email_from_user_id=(userId or None),
                    )
        except Exception:
            pass

        # ---------------- APO notifications ----------------
        # Notify APO in-app + Gmail whenever OM updates a Special Class record.
        try:
            if res.modified_count:
                updated_doc = await db[COL_SPECIAL].find_one(
                    {"term_id": current_term_id, "special_id": specialId},
                    {"_id": 0, "status": 1, "course_id": 1, "courseId": 1, "section_id": 1, "section_code": 1, "schedule_entries": 1},
                ) or {}

                course_id = _safe_str(updated_doc.get("course_id") or updated_doc.get("courseId") or course_id_base)
                course_code = ""
                if course_id:
                    c = await db[COL_COURSES].find_one({"course_id": course_id}, {"_id": 0, "course_code": 1}) or {}
                    cc = c.get("course_code")
                    course_code = _safe_str(cc[0]) if isinstance(cc, list) and cc else _safe_str(cc)

                section_code = _safe_str(updated_doc.get("section_code"))
                if not section_code:
                    sid = _safe_str(updated_doc.get("section_id"))
                    if sid:
                        sdoc = await db[COL_SECTIONS].find_one({"section_id": sid}, {"_id": 0, "section_code": 1}) or {}
                        section_code = _safe_str(sdoc.get("section_code"))

                summary = " ".join([p for p in [course_code, section_code] if p]).strip() or f"Special Class {specialId}"
                campus_id = await _campus_id_for_special_doc(updated_doc)

                await _notify_apo_for_specialclass(
                    term_id=current_term_id,
                    special_id=specialId,
                    course_id=course_id,
                    status=_safe_str(updated_doc.get("status")),
                    summary=summary,
                    campus_id=campus_id,
                    email_from_user_id=(userId or None),
                )
        except Exception:
            pass

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

        special_ids = [str(x).strip() for x in payload["special_ids"] if str(x).strip()]

        # Snapshot previous statuses for notification logic (best-effort).
        prev_docs = []
        try:
            prev_docs = await db[COL_SPECIAL].find(
                {"term_id": current_term_id, "special_id": {"$in": special_ids}},
                {"_id": 0, "special_id": 1, "status": 1, "department_id": 1, "dept_id": 1, "course_id": 1, "courseId": 1, "section_id": 1, "section_code": 1, "assignment_id": 1, "faculty_assignment_id": 1, "user_id": 1,},
            ).to_list(5000)
        except Exception:
            prev_docs = []

        res = await db[COL_SPECIAL].update_many(
            {"term_id": current_term_id, "special_id": {"$in": special_ids}},
            {"$set": {"status": target_status, "updated_at": datetime.utcnow()}},
        )

        converted_docs: List[Dict[str, Any]] = []
        try:
            if res.modified_count and target_status == "Convert to Regular Class":
                converted_docs = await db[COL_SPECIAL].find(
                    {"term_id": current_term_id, "special_id": {"$in": special_ids}},
                    {
                        "_id": 0,
                        "special_id": 1,
                        "course_id": 1,
                        "courseId": 1,
                        "section_id": 1,
                    },
                ).to_list(5000)
                for d in converted_docs:
                    sec_id = _safe_str(d.get("section_id"))
                    course_id = _safe_str(d.get("course_id") or d.get("courseId"))
                    if sec_id:
                        await _regularize_special_section_bundle(section_id=sec_id, term_id=current_term_id, course_id=course_id)
        except Exception:
            converted_docs = []

        joined_group_special_ids: List[str] = []
        if target_status == "Approved" and prev_docs:
            for d in (prev_docs or []):
                sid = _safe_str(d.get("special_id"))
                if not sid or _safe_str(d.get("status")) == "Approved":
                    continue
                course_id = _safe_str(d.get("course_id") or d.get("courseId"))
                if not course_id:
                    continue
                binding = await _find_existing_approved_group_binding(
                    current_term_id,
                    course_id,
                    exclude_special_ids=[sid],
                )
                if not binding:
                    continue
                await db[COL_SPECIAL].update_one(
                    {"term_id": current_term_id, "special_id": sid},
                    {"$set": {
                        "section_id": binding.get("section_id"),
                        "schedule_id1": binding.get("schedule_id1"),
                        "schedule_id2": binding.get("schedule_id2"),
                        "assignment_id": binding.get("assignment_id"),
                        "schedule_cleared": bool(binding.get("schedule_cleared", False)),
                        **({"faculty_response": binding.get("faculty_response")} if binding.get("faculty_response") else {}),
                        **({"faculty_accepted_at": binding.get("faculty_accepted_at")} if binding.get("faculty_accepted_at") else {}),
                        "faculty_rejected_at": None,
                        "updated_at": datetime.utcnow(),
                    }},
                )
                joined_group_special_ids.append(sid)

        # Notify chairs for approvals / updates (best-effort; never blocks).
        try:
            if target_status == "Approved" and prev_docs:
                for d in prev_docs:
                    sid = _safe_str(d.get("special_id"))
                    dept_id_for_notify = _safe_str(d.get("department_id") or d.get("dept_id") or d.get("departmentId"))
                    if not sid or not dept_id_for_notify:
                        continue
                    prev_status = _safe_str(d.get("status"))

                    # Build a short summary (course code + section code if possible).
                    course_id = _safe_str(d.get("course_id") or d.get("courseId"))
                    course_code = ""
                    if course_id:
                        c = await db[COL_COURSES].find_one({"course_id": course_id}, {"_id": 0, "course_code": 1})
                        cc = (c or {}).get("course_code")
                        if isinstance(cc, list) and cc:
                            course_code = _safe_str(cc[0])
                        else:
                            course_code = _safe_str(cc)

                    section_code = _safe_str(d.get("section_code"))
                    if not section_code:
                        sec_id = _safe_str(d.get("section_id"))
                        if sec_id:
                            sdoc = await db[COL_SECTIONS].find_one({"section_id": sec_id}, {"_id": 0, "section_code": 1})
                            section_code = _safe_str((sdoc or {}).get("section_code"))

                    summary = " ".join([p for p in [course_code, section_code] if p]).strip() or f"Special Class {sid}"

                    # FACULTY notifications (in-app + Gmail)
                    try:
                        fac_uid, _fac_id = await _resolve_faculty_user_for_special_row(d)
                        if fac_uid:
                            if prev_status != "Approved":
                                await _notify_faculty_for_specialclass(
                                    faculty_user_id=fac_uid,
                                    kind="new",
                                    special_id=sid,
                                    summary=f"An approved Special Class was reflected to your schedule: {summary}",
                                    term_id=current_term_id,
                                )
                            else:
                                await _notify_faculty_for_specialclass(
                                    faculty_user_id=fac_uid,
                                    kind="update",
                                    special_id=sid,
                                    summary=f"A reflected Special Class in your schedule was updated: {summary}",
                                    term_id=current_term_id,
                                )
                    except Exception:
                        pass

                    if prev_status != "Approved":
                        await _notify_chairs_for_specialclass(
                            dept_id_for_notify,
                            kind="new",
                            special_id=sid,
                            summary=f"Approved Special Class in Plantilla: {summary}",
                        )
                    else:
                        await _notify_chairs_for_specialclass(
                            dept_id_for_notify,
                            kind="update",
                            special_id=sid,
                            summary=f"Reflected Special Class updated in Plantilla: {summary}",
                        )
        except Exception:
            pass
        

        # ---------------- CONVERSION notifications (bulkUpdate) ----------------
        try:
            if converted_docs:
                course_ids = list({
                    _safe_str(d.get("course_id") or d.get("courseId"))
                    for d in converted_docs
                    if _safe_str(d.get("course_id") or d.get("courseId"))
                })
                code_map: Dict[str, str] = {}
                if course_ids:
                    cdocs = await db[COL_COURSES].find(
                        {"course_id": {"$in": course_ids}},
                        {"_id": 0, "course_id": 1, "course_code": 1},
                    ).to_list(10000)
                    for c in cdocs or []:
                        cid = _safe_str(c.get("course_id"))
                        cc = c.get("course_code")
                        code_map[cid] = _safe_str(cc[0]) if isinstance(cc, list) and cc else _safe_str(cc)

                special_ids_for_meta = [
                    _safe_str(d.get("special_id")) for d in converted_docs if _safe_str(d.get("special_id"))
                ]
                labels: List[str] = []
                faculty_uids: set[str] = set()
                student_uids: set[str] = set()
                for d in converted_docs:
                    fac_uid, _ = await _resolve_faculty_user_for_special_row(d)
                    if fac_uid:
                        faculty_uids.add(fac_uid)
                    stu_uid = _safe_str(d.get("user_id") or d.get("student_user_id"))
                    if stu_uid:
                        student_uids.add(stu_uid)
                    cid = _safe_str(d.get("course_id") or d.get("courseId"))
                    sec_code = _safe_str(d.get("section_code"))
                    label_parts = [p for p in [code_map.get(cid, cid), sec_code] if p]
                    label = " ".join(label_parts).strip() or (f"Special ID: {_safe_str(d.get('special_id'))}" if _safe_str(d.get("special_id")) else "Special Class")
                    if label and label not in labels:
                        labels.append(label)

                summary = labels[0] if len(labels) == 1 else f"{len(labels)} special class request{'s' if len(labels) != 1 else ''}"
                title, details = _special_class_conversion_notification(summary)

                for uid in sorted(faculty_uids):
                    await create_notification(
                        user_id=uid,
                        title=title,
                        details=details,
                        meta={
                            "route": "/faculty/overview",
                            "kind": "special_class_converted_regular",
                            "term_id": current_term_id,
                            "special_ids": special_ids_for_meta,
                        },
                        send_email=True,
                        email_from_user_id=(userId or None),
                    )
                for uid in sorted(student_uids):
                    await create_notification(
                        user_id=uid,
                        title=title,
                        details=details,
                        meta={
                            "route": "/student/specialclass",
                            "kind": "special_class_converted_regular",
                            "term_id": current_term_id,
                            "special_ids": special_ids_for_meta,
                        },
                        send_email=True,
                        email_from_user_id=(userId or None),
                    )
        except Exception:
            pass

        # ---------------- GROUP JOIN notifications (bulkUpdate) ----------------
        try:
            if joined_group_special_ids:
                joined_summary = f"{len(joined_group_special_ids)} student request{'s' if len(joined_group_special_ids) != 1 else ''} joined an already approved Special Class group."
                om_uids = await _role_user_ids_by_name_patterns([r"office\s*manager", r"\bom\b"])
                for om_uid in om_uids:
                    await create_notification(
                        user_id=om_uid,
                        title="Special Class group updated",
                        details=joined_summary,
                        meta={
                            "route": "/om/special-class",
                            "kind": "special_class_group_join",
                            "term_id": current_term_id,
                            "special_ids": joined_group_special_ids,
                        },
                        send_email=True,
                        email_from_user_id=(userId or None),
                    )
                for sid in joined_group_special_ids:
                    updated_joined = await db[COL_SPECIAL].find_one(
                        {"term_id": current_term_id, "special_id": sid},
                        {"_id": 0, "assignment_id": 1, "faculty_assignment_id": 1, "section_id": 1},
                    ) or {}
                    fac_uid, _ = await _resolve_faculty_user_for_special_row(updated_joined)
                    if fac_uid:
                        await _notify_faculty_for_specialclass(
                            faculty_user_id=fac_uid,
                            kind="update",
                            special_id=sid,
                            summary=joined_summary,
                            term_id=current_term_id,
                        )
        except Exception:
            pass

        # ---------------- STUDENT notifications (bulkUpdate) ----------------
        # Notify each affected student when OM bulk-updates Special Class statuses.
        try:
            if res.modified_count and prev_docs and target_status != "Convert to Regular Class":
                # Build a small course_code map to avoid per-row lookups.
                course_ids = []
                for d in prev_docs:
                    cid = _safe_str(d.get("course_id") or d.get("courseId"))
                    if cid:
                        course_ids.append(cid)
                course_ids = list(dict.fromkeys([c for c in course_ids if c]))
                code_map = {}
                if course_ids:
                    cdocs = await db[COL_COURSES].find({"course_id": {"$in": course_ids}}, {"_id": 0, "course_id": 1, "course_code": 1}).to_list(5000)
                    for c in cdocs or []:
                        cid = _safe_str(c.get("course_id"))
                        cc = c.get("course_code")
                        disp = _safe_str(cc[0]) if isinstance(cc, list) and cc else _safe_str(cc)
                        if cid:
                            code_map[cid] = disp

                by_user = {}
                for d in prev_docs:
                    uid = _safe_str(d.get("user_id") or d.get("student_user_id"))
                    if not uid:
                        continue
                    prev_s = _safe_str(d.get("status"))
                    if prev_s == target_status:
                        continue
                    sid = _safe_str(d.get("special_id"))
                    cid = _safe_str(d.get("course_id") or d.get("courseId"))
                    label = code_map.get(cid, cid)
                    if sid:
                        label = f"{label} (Special ID: {sid})" if label else f"Special ID: {sid}"
                    by_user.setdefault(uid, []).append(label or sid or 'Special Class')

                for uid, items in by_user.items():
                    title = "Special Class approved" if target_status == "Approved" else "Special Class updated"
                    lines = [f"Status: {target_status}"]
                    if items:
                        lines.append("Updated request(s):")
                        for it in items[:12]:
                            lines.append(f"• {it}")
                        if len(items) > 12:
                            lines.append(f"• +{len(items)-12} more")
                    details = "\n".join(lines)

                    await create_notification(
                        user_id=uid,
                        title=title,
                        details=details,
                        meta={
                            "route": "/student/specialclass",
                            "kind": "student_specialclass_updated",
                            "term_id": current_term_id,
                        },
                        send_email=True,
                        email_from_user_id=(userId or None),
                    )
        except Exception:
            pass


        # ---------------- APO notifications (bulkUpdate) ----------------
        # Send one summary notification per campus (best-effort) to avoid spamming APO.
        try:
            if res.modified_count and prev_docs:
                # Build campus map for linked sections
                sec_ids = list({ _safe_str(d.get("section_id")) for d in prev_docs if _safe_str(d.get("section_id")) })
                sec_map = {}
                if sec_ids:
                    sdocs = await db[COL_SECTIONS].find({"section_id": {"$in": sec_ids}}, {"_id": 0, "section_id": 1, "campus_id": 1, "section_code": 1}).to_list(10000)
                    for s in sdocs or []:
                        sec_map[_safe_str(s.get("section_id"))] = _safe_str(s.get("campus_id")).upper()

                # course code map (reuse from student notif block if available)
                course_ids = []
                for d in prev_docs:
                    cid = _safe_str(d.get("course_id") or d.get("courseId"))
                    if cid:
                        course_ids.append(cid)
                course_ids = list(dict.fromkeys([c for c in course_ids if c]))
                code_map = {}
                if course_ids:
                    cdocs = await db[COL_COURSES].find({"course_id": {"$in": course_ids}}, {"_id": 0, "course_id": 1, "course_code": 1}).to_list(10000)
                    for c in cdocs or []:
                        cid = _safe_str(c.get("course_id"))
                        cc = c.get("course_code")
                        code_map[cid] = _safe_str(cc[0]) if isinstance(cc, list) and cc else _safe_str(cc)

                by_campus = {}
                for d in prev_docs:
                    prev_s = _safe_str(d.get("status"))
                    if prev_s == target_status:
                        continue
                    sid = _safe_str(d.get("special_id"))
                    cid = _safe_str(d.get("course_id") or d.get("courseId"))
                    label = code_map.get(cid, cid)
                    sec_id = _safe_str(d.get("section_id"))
                    campus = sec_map.get(sec_id, "")
                    by_campus.setdefault(campus, []).append(label or sid or 'Special Class')

                for campus_id, items in by_campus.items():
                    if not items:
                        continue
                    # Resolve recipients
                    apo_uids = await _apo_user_ids_for_campus(campus_id) if campus_id else []
                    if not apo_uids:
                        apo_uids = await _all_apo_user_ids()
                    if not apo_uids:
                        continue

                    title = "Special Class updated"
                    lines = [f"Status: {target_status}", f"Updated request(s): {len(items)}"]
                    if campus_id:
                        lines.append(f"Campus: {campus_id}")
                    # show up to 10 sample course codes
                    for it in items[:10]:
                        lines.append(f"• {it}")
                    if len(items) > 10:
                        lines.append(f"• +{len(items)-10} more")
                    details = "\n".join(lines)

                    meta = {
                        "route": "/apo/courseofferings",
                        "kind": "special_class_bulk_updated",
                        "term_id": current_term_id,
                        "campus_id": campus_id,
                        "status": target_status,
                    }

                    for uid in apo_uids:
                        await create_notification(
                            user_id=uid,
                            title=title,
                            details=details,
                            meta=meta,
                            send_email=True,
                            email_from_user_id=(userId or None),
                        )
        except Exception:
            pass

        return {"ok": True, "matched": res.matched_count, "modified": res.modified_count, "status": target_status}

    # Export PDF: one or many rows
    if action == "exportPdf":
        selected_ids: List[str] = []
        if payload and isinstance(payload.get("special_ids"), list):
            selected_ids = [str(x).strip() for x in payload["special_ids"] if str(x).strip()]

        # If specialId is explicitly provided, it takes precedence (single export)
        if specialId and specialId.strip():
            selected_ids = [specialId.strip()]

        if not selected_ids:
            raise HTTPException(status_code=400, detail="Please select at least one application row to export.")

        # De-duplicate while preserving order
        seen: set[str] = set()
        ordered_ids: List[str] = []
        for sid in selected_ids:
            if sid not in seen:
                ordered_ids.append(sid)
                seen.add(sid)
        selected_ids = ordered_ids

        # Fetch selected docs
        docs = await db[COL_SPECIAL].find(
            {"term_id": current_term_id, "special_id": {"$in": selected_ids}},
            {"_id": 0},
        ).to_list(len(selected_ids))

        if not docs:
            raise HTTPException(status_code=404, detail="Application not found for export.")

        by_id: Dict[str, Dict[str, Any]] = {str(d.get("special_id")): d for d in docs if d.get("special_id")}
        missing = [sid for sid in selected_ids if sid not in by_id]
        if missing:
            raise HTTPException(
                status_code=404,
                detail=f"Some selected applications were not found for export: {', '.join(missing)}",
            )

        ordered_docs = [by_id[sid] for sid in selected_ids]

        maps = await _bulk_maps_for_rows(ordered_docs)
        shaped = [await _shape_row(d, maps) for d in ordered_docs]
        pdf_bytes = _build_pdf(shaped, active_term=active)

        if len(selected_ids) == 1:
            fname = f"SpecialClass_{selected_ids[0]}.pdf"
        else:
            fname = f"SpecialClass_Selected_{datetime.utcnow().strftime('%Y-%m-%d')}.pdf"

        headers = {"Content-Disposition": f'attachment; filename="{fname}"'}
        return StreamingResponse(io.BytesIO(pdf_bytes), media_type="application/pdf", headers=headers)

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
