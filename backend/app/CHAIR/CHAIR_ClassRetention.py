from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Body
from pymongo import ASCENDING, ReturnDocument
from pymongo.errors import DuplicateKeyError
from bson import ObjectId

from ..main import db
from .. import Notifications as _notifications

from ..Notifications import create_notification
from uuid import uuid4
router = APIRouter(prefix="/chair", tags=["chair"])

# --- collections ---
COL_CLASS_RETENTION = "class_retention"
COL_TERMS = "terms"
COL_COURSES = "courses"
COL_SECTIONS = "sections"
COL_CAMPUSES = "campuses"
COL_USERS = "users"
COL_FAC_PROFILES = "faculty_profiles"
COL_FAC_ASSIGN = "faculty_assignments"
COL_PREEN_COUNT = "preenlistment_count" 

STATUS_OPTIONS = ["Approved", "Under Review", "Convert to Special Class", "Dissolved"]


def _status_to_section_remarks_tag(status: str) -> str:
    """Map Class Retention status → sections.remarks tag used by APO + OM screens.

    We only tag Dissolved in sections.remarks so APO_CourseOfferings and OM_LoadAssignment can see it.
    """
    s = (status or "").strip().lower()
    if s == "dissolved":
        return "DISSOLVED"
    return ""


async def _ensure_section_remarks_tag(section_id: Optional[str], status: str, now: datetime) -> None:
    """Ensure sections.remarks contains a marker for Dissolved.

    Notes:
    - APO_CourseOfferings reads section remarks from `sections.remarks` and exposes it as `section_remarks`.
    - OM_LoadAssignment also preloads remarks from `sections.remarks` (not from `sections_submitted`).
    """
    sid = (section_id or "").strip()
    tag = _status_to_section_remarks_tag(status)
    if not sid or not tag:
        return

    sec = await db[COL_SECTIONS].find_one({"section_id": sid}, {"_id": 0, "remarks": 1})
    if not sec:
        return
    cur = str(sec.get("remarks") or "").strip()
    if tag.lower() in cur.lower():
        return

    new_remarks = tag if not cur else f"{cur} | {tag}"
    await db[COL_SECTIONS].update_one(
        {"section_id": sid},
        {"$set": {"remarks": new_remarks, "updated_at": now}},
    )


async def _broadcast_dissolved_to_students(*, term_id: str, course_id: str, section_id: str, enrolled: Any = None) -> None:
    """Broadcast an in-app notification to all students when a class is dissolved.

    IMPORTANT: In-app only (no email) to avoid mass mailing.
    """
    try:
        student_ids = await _notifications._get_all_student_user_ids()
        if not student_ids:
            return

        # Resolve display fields (best-effort).
        course = await db[COL_COURSES].find_one(
            {"course_id": course_id},
            {"_id": 0, "course_code": 1, "course_title": 1},
        ) or {}
        cc = course.get("course_code")
        course_code = (cc[0] if isinstance(cc, list) and cc else cc) or ""
        course_code = str(course_code or "").strip()
        course_title = str(course.get("course_title") or "").strip()

        sec = await db[COL_SECTIONS].find_one(
            {"section_id": section_id},
            {"_id": 0, "section_code": 1, "enrolled": 1},
        ) or {}
        section_code = str(sec.get("section_code") or "").strip()
        enrolled_val = enrolled
        if enrolled_val is None:
            enrolled_val = sec.get("enrolled")

        title = "Class dissolved (low enrollment)"
        details_lines = [
            "A class was marked as Dissolved due to low enrollment.",
        ]
        if course_code or course_title:
            details_lines.append(f"Course: {course_code} — {course_title}".strip(" —"))
        if section_code:
            if enrolled_val is not None and str(enrolled_val) != "":
                details_lines.append(f"Section: {section_code} (enrolled: {enrolled_val})")
            else:
                details_lines.append(f"Section: {section_code}")
        details = "\n".join([x for x in details_lines if x])

        meta = {
            "route": "/student/courseofferings",
            "kind": "class_dissolved",
            "term_id": term_id,
            "course_id": course_id,
            "section_id": section_id,
        }

        created_at = datetime.utcnow().isoformat() + "Z"

        docs = [
            {
                "notif_id": f"NTF{uuid4().hex[:12].upper()}",
                "user_id": uid,
                "title": title,
                "details": details,
                "created_at": created_at,
                "seen": False,
                "seen_at": None,
                "meta": meta,
            }
            for uid in student_ids
        ]

        # Insert in batches to avoid huge payloads.
        for i in range(0, len(docs), 1000):
            await db["notifications"].insert_many(docs[i : i + 1000])
    except Exception:
        # best-effort only
        return


async def _notify_interested_students_dissolved(
    *,
    term_id: str,
    course_id: str,
    section_id: str,
    enrolled: Any = None,
    email_from_user_id: str | None = None,
) -> None:
    """Notify *interested* students (in-app + Gmail) that a class was dissolved.

    We avoid mass-emailing ALL students. "Interested" is best-effort:
    - Students who filed a petition for this course in this term.
    - Students who submitted a Special Class request for this course in this term.
    """

    try:
        term_id = str(term_id or "").strip()
        course_id = str(course_id or "").strip()
        section_id = str(section_id or "").strip()
        if not term_id or not course_id:
            return

        uids: set[str] = set()

        # (1) Petitioners
        try:
            pet_uids = await db.get_collection("student_petitions").distinct(
                "user_id",
                {"term_id": term_id, "course_id": course_id, "petition_id": {"$exists": True}},
            )
            for u in pet_uids or []:
                s = str(u or "").strip()
                if s:
                    uids.add(s)
        except Exception:
            pass

        # (2) Special class requesters (new + legacy key)
        try:
            sc_uids = await db.get_collection("special_class").distinct(
                "user_id",
                {"term_id": term_id, "course_id": course_id},
            )
            for u in sc_uids or []:
                s = str(u or "").strip()
                if s:
                    uids.add(s)
        except Exception:
            pass

        try:
            sc_uids2 = await db.get_collection("special_class").distinct(
                "student_user_id",
                {"term_id": term_id, "course_id": course_id},
            )
            for u in sc_uids2 or []:
                s = str(u or "").strip()
                if s:
                    uids.add(s)
        except Exception:
            pass

        if not uids:
            return

        # Resolve display fields (best-effort).
        course = await db[COL_COURSES].find_one(
            {"course_id": course_id},
            {"_id": 0, "course_code": 1, "course_title": 1},
        ) or {}
        cc = course.get("course_code")
        course_code = (cc[0] if isinstance(cc, list) and cc else cc) or ""
        course_code = str(course_code or "").strip()
        course_title = str(course.get("course_title") or "").strip()

        sec = await db[COL_SECTIONS].find_one(
            {"section_id": section_id},
            {"_id": 0, "section_code": 1, "enrolled": 1},
        ) or {}
        section_code = str(sec.get("section_code") or "").strip()
        enrolled_val = enrolled if enrolled is not None else sec.get("enrolled")

        title = "Class dissolved (low enrollment)"
        parts = ["A class was marked as Dissolved due to low enrollment."]
        if course_code or course_title:
            parts.append(f"Course: {course_code} — {course_title}".strip(" —"))
        if section_code:
            if enrolled_val is not None and str(enrolled_val) != "":
                parts.append(f"Section: {section_code} (enrolled: {enrolled_val})")
            else:
                parts.append(f"Section: {section_code}")
        details = "\n".join([p for p in parts if p])

        meta = {
            "route": "/student/courseofferings",
            "kind": "class_dissolved",
            "term_id": term_id,
            "course_id": course_id,
            "section_id": section_id,
        }

        for uid in sorted(uids):
            try:
                await create_notification(
                    user_id=uid,
                    title=title,
                    details=details,
                    meta=meta,
                    send_email=True,
                    email_from_user_id=email_from_user_id,
                )
            except Exception:
                continue
    except Exception:
        return

async def _campus_id_for_section(section_id: str) -> str:
    """Best-effort resolve campus_id for a section."""
    sid = (section_id or "").strip()
    if not sid:
        return ""
    try:
        sec = await db[COL_SECTIONS].find_one({"section_id": sid}, {"_id": 0, "campus_id": 1}) or {}
        return str(sec.get("campus_id") or "").strip().upper()
    except Exception:
        return ""


async def _campus_display_name(campus_id_or_name: str) -> str:
    """Return a human-friendly campus name (best-effort).

    Requirement: notifications should show campus *name* (not the id).
    Data can be inconsistent across deployments:
      - sections.campus_id might store campuses.campus_id (e.g., "CMPS0001")
      - or it might already store a campus name (e.g., "Manila")
    """
    v = (campus_id_or_name or "").strip()
    if not v:
        return ""
    try:
        # 1) direct campus_id match
        doc = await db[COL_CAMPUSES].find_one({"campus_id": v}, {"_id": 0, "campus_name": 1})
        if doc and doc.get("campus_name"):
            return str(doc["campus_name"]).strip()

        # 2) uppercase campus_id match
        doc = await db[COL_CAMPUSES].find_one({"campus_id": v.upper()}, {"_id": 0, "campus_name": 1})
        if doc and doc.get("campus_name"):
            return str(doc["campus_name"]).strip()

        # 3) exact campus_name match (case-insensitive)
        doc = await db[COL_CAMPUSES].find_one(
            {"campus_name": {"$regex": f"^{v}$", "$options": "i"}},
            {"_id": 0, "campus_name": 1},
        )
        if doc and doc.get("campus_name"):
            return str(doc["campus_name"]).strip()
    except Exception:
        pass

    # Fallback: show the raw value (better than blank).
    return v


async def _apo_user_ids_for_campus(campus_id: str) -> list[str]:
    """Return APO user_ids scoped to the given campus (best-effort).

    Mirrors OM_LoadAssignment's dynamic role resolution:
    - Resolve APO role_id from user_roles (role_type contains 'APO')
    - Read role_assignments and filter by campus scope
    - Fallback to legacy users.role + users.campus_id
    """
    campus_id = (campus_id or "").strip().upper()
    if not campus_id:
        return []

    role_apo = ""
    try:
        role_doc = await db.get_collection("user_roles").find_one(
            {"role_type": {"$regex": "APO", "$options": "i"}},
            {"_id": 0, "role_id": 1},
        )
        role_apo = str((role_doc or {}).get("role_id") or "").strip()
    except Exception:
        role_apo = ""

    if not role_apo:
        role_apo = "ROLE0004"  # backward-compatible fallback

    def _scope_has_campus(scope_val) -> bool:
        if not scope_val:
            return False
        scopes = scope_val if isinstance(scope_val, list) else [scope_val]
        for s in scopes:
            if not isinstance(s, dict):
                continue
            typ = str(s.get("type") or s.get("scope_type") or "").strip().lower()
            sid = str(s.get("id") or s.get("scope_id") or s.get("campus_id") or "").strip().upper()
            if sid == campus_id and (typ in ("campus", "campuses", "") or "campus" in typ):
                return True
        return False

    out: set[str] = set()

    # Role-assignment scoped APO users
    try:
        docs = (
            await db.get_collection("role_assignments")
            .find({"role_id": role_apo}, {"_id": 0, "user_id": 1, "scope": 1})
            .to_list(None)
        )
    except Exception:
        docs = []

    for d in docs or []:
        uid = str(d.get("user_id") or "").strip()
        if not uid:
            continue
        if _scope_has_campus(d.get("scope")):
            out.add(uid)

    # Legacy fallback
    try:
        cur = db.get_collection(COL_USERS).find(
            {"role": {"$regex": "APO", "$options": "i"}, "campus_id": campus_id},
            {"_id": 0, "user_id": 1},
        )
        async for u in cur:
            uid = str(u.get("user_id") or "").strip()
            if uid:
                out.add(uid)
    except Exception:
        pass

    return sorted(list(out))


async def _all_apo_user_ids() -> list[str]:
    """Return all APO user_ids (best-effort)."""
    uids: set[str] = set()

    try:
        role_doc = await db["user_roles"].find_one({"role_type": {"$regex": "APO", "$options": "i"}}, {"_id": 0, "role_id": 1})
        role_id = str((role_doc or {}).get("role_id") or "").strip()
        if role_id:
            cur = db["role_assignments"].find({"role_id": role_id}, {"_id": 0, "user_id": 1})
            async for r in cur:
                uid = (r or {}).get("user_id")
                if uid:
                    uids.add(str(uid))
    except Exception:
        pass

    try:
        cur2 = db[COL_USERS].find({"role": {"$regex": r"\bAPO\b", "$options": "i"}}, {"_id": 0, "user_id": 1})
        async for r in cur2:
            uid = (r or {}).get("user_id")
            if uid:
                uids.add(str(uid))
    except Exception:
        pass

    return sorted(uids)


async def _notify_apo_dissolved(*, term_id: str, course_id: str, section_id: str, enrolled: Any = None, email_from_user_id: str | None = None) -> None:
    """Notify APO (in-app + Gmail) that a class was dissolved."""
    try:
        campus_id = await _campus_id_for_section(section_id)
        apo_uids = await _apo_user_ids_for_campus(campus_id) if campus_id else []
        if not apo_uids:
            apo_uids = await _all_apo_user_ids()
        if not apo_uids:
            return

        course = await db[COL_COURSES].find_one({"course_id": course_id}, {"_id": 0, "course_code": 1, "course_title": 1}) or {}
        cc = course.get("course_code")
        course_code = (cc[0] if isinstance(cc, list) and cc else cc) or ""
        course_code = str(course_code or "").strip()
        course_title = str(course.get("course_title") or "").strip()

        sec = await db[COL_SECTIONS].find_one({"section_id": section_id}, {"_id": 0, "section_code": 1, "enrolled": 1, "campus_id": 1}) or {}
        section_code = str(sec.get("section_code") or "").strip()
        if enrolled is None:
            enrolled = sec.get("enrolled")

        title = "Class dissolved (low enrollment)"
        parts = ["A class was marked as Dissolved due to low enrollment."]
        if course_code or course_title:
            parts.append(f"Course: {course_code} — {course_title}".strip(" —"))
        if section_code:
            if enrolled is not None and str(enrolled) != "":
                parts.append(f"Section: {section_code} (enrolled: {enrolled})")
            else:
                parts.append(f"Section: {section_code}")
        if campus_id:
            campus_name = await _campus_display_name(campus_id)
            if campus_name:
                parts.append(f"Campus: {campus_name}")
        details = "\n".join([p for p in parts if p])

        meta = {
            "route": "/apo/courseofferings",
            "kind": "class_dissolved",
            "term_id": term_id,
            "course_id": course_id,
            "section_id": section_id,
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

# indexes (safe with Motor or PyMongo; ignore failures)
try:
    db[COL_CLASS_RETENTION].create_index([("term_id", ASCENDING)])
    db[COL_CLASS_RETENTION].create_index([("course_id", ASCENDING)])
    db[COL_CLASS_RETENTION].create_index([("section_id", ASCENDING)])
    db[COL_CLASS_RETENTION].create_index([("status", ASCENDING)])
    db[COL_CLASS_RETENTION].create_index([("updated_at", ASCENDING)])
    db[COL_FAC_ASSIGN].create_index([("section_id", ASCENDING), ("created_at", ASCENDING)])
    # Prevent duplicates: one retention row per term + section
    db[COL_CLASS_RETENTION].create_index(
        [("term_id", ASCENDING), ("course_id", ASCENDING), ("section_id", ASCENDING)],
        unique=True
    )

except Exception:
    pass


def _course_code_expr() -> Dict[str, Any]:
    # Handles array-or-scalar course_code
    return {
        "$ifNull": [
            {"$arrayElemAt": ["$course.course_code", 0]},
            {"$ifNull": ["$course.course_code", ""]},
        ]
    }


def _term_label_expr() -> Dict[str, Any]:
    # Term {term_number} · AY {acad_year_start}-{acad_year_start+1}
    return {
        "$concat": [
            "Term ",
            {"$toString": {"$ifNull": ["$term.term_number", ""]}},
            " · AY ",
            {"$toString": {"$ifNull": ["$term.acad_year_start", ""]}},
            "-",
            {
                "$toString": {
                    "$add": [
                        {"$ifNull": ["$term.acad_year_start", 0]},
                        1,
                    ]
                }
            },
        ]
    }

def _upper_last_first_from_user_expr() -> Dict[str, Any]:
    """
    Build "LASTNAME, FIRSTNAME" (ALL CAPS) from either faculty_profiles or users.
    Joins are already unwound to 'fac' (faculty_profiles) and 'u' (users).
    """
    return {
        "$let": {
            "vars": {
                "ln": {
                    "$ifNull": [
                        "$fac.last_name",
                        {"$ifNull": ["$u.lastName", "$u.last_name"]},
                    ]
                },
                "fn": {
                    "$ifNull": [
                        "$fac.first_name",
                        {"$ifNull": ["$u.firstName", "$u.first_name"]},
                    ]
                },
            },
            "in": {
                "$toUpper": {
                    "$concat": [
                        {"$ifNull": ["$$ln", ""]},
                        ", ",
                        {"$ifNull": ["$$fn", ""]},
                    ]
                }
            },
        }
    }


def _list_pipeline(term_id: Optional[str], status: Optional[str], q: Optional[str]) -> List[Dict[str, Any]]:
    """
    - Excludes rows with missing/blank section_id (garbage/orphans).
    - Requires an actual section join.
    - Filters by the joined section's term (authoritative).
    - Deduplicates by section_id (keeps latest updated_at/_id).
    - Derives faculty from latest non-archived faculty_assignments.
    """
    base_match: Dict[str, Any] = {
        "section_id": {"$type": "string", "$ne": ""}
    }
    # Only consider retention rows that belong to the WORKING term
    if term_id:
        base_match["term_id"] = term_id

    if status and status not in ("All Status", ""):
        base_match["status"] = status

    pipeline: List[Dict[str, Any]] = [
        {"$match": base_match},

        # join term (by retention.term_id), course, section (require section)
        {"$lookup": {"from": COL_TERMS, "localField": "term_id", "foreignField": "term_id", "as": "term"}},
        {"$unwind": {"path": "$term", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": COL_COURSES, "localField": "course_id", "foreignField": "course_id", "as": "course"}},
        {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": COL_SECTIONS, "localField": "section_id", "foreignField": "section_id", "as": "section"}},
        {"$unwind": {"path": "$section", "preserveNullAndEmptyArrays": False}},  # require existing section

        # authoritative term filter: from the section's term
        *([{ "$match": { "section.term_id": term_id } }] if term_id else []),

        # authoritative faculty via latest non-archived assignment
        {
            "$lookup": {
                "from": COL_FAC_ASSIGN,
                "let": {"sid": "$section_id"},
                "pipeline": [
                    {"$match": {
                        "$expr": {
                            "$and": [
                                {"$eq": ["$section_id", "$$sid"]},
                                {"$ne": ["$is_archived", True]},
                            ]
                        }
                    }},
                    {"$sort": {"created_at": -1}},
                    {"$limit": 1},
                ],
                "as": "fa"
            }
        },
        {"$unwind": {"path": "$fa", "preserveNullAndEmptyArrays": True}},

        # profiles & users from the derived assignment
        {"$lookup": {
            "from": COL_FAC_PROFILES,
            "localField": "fa.faculty_id",
            "foreignField": "faculty_id",
            "as": "fac",
        }},
        {"$unwind": {"path": "$fac", "preserveNullAndEmptyArrays": True}},

        # users: support both userId and user_id in the users collection
        {
            "$lookup": {
                "from": COL_USERS,
                "let": {"uid": "$fac.user_id"},
                "pipeline": [
                    {
                        "$match": {
                            "$expr": {
                                "$or": [
                                    {"$eq": ["$userId", "$$uid"]},
                                    {"$eq": ["$user_id", "$$uid"]},
                                ]
                            }
                        }
                    },
                    {"$limit": 1},
                ],
                "as": "u",
            }
        },
        {"$unwind": {"path": "$u", "preserveNullAndEmptyArrays": True}},

        # optional text filter
        *([{
            "$match": {
                "$or": [
                    {"course.course_code": {"$regex": q, "$options": "i"}},
                    {"course.course_title": {"$regex": q, "$options": "i"}},
                    {"section.section_code": {"$regex": q, "$options": "i"}},
                ]
            }
        }] if q else []),

        # DEDUPE: keep only the latest row per (course, section)
        {"$sort": {"updated_at": -1, "_id": -1}},
        {"$group": {
            "_id": {
                "section_id": "$section_id",
                "course_id": "$course_id",
            },
            "doc": { "$first": "$$ROOT" }
        }},
        {"$replaceRoot": { "newRoot": "$doc" }},

        # final shape
        {"$project": {
            "_id": 0,
            "retention_id": {"$toString": "$_id"},
            "term_id": 1, "course_id": 1, "section_id": 1,
            "faculty_id": {"$ifNull": ["$fa.faculty_id", None]},
            "student_units": 1, "faculty_units": 1, "status": {"$cond": [{"$eq": ["$status", "Special Class"]}, "Dissolved", "$status"]},
            "created_at": 1, "updated_at": 1,
            "enrolled": {"$ifNull": ["$enrolled", "$section.enrolled"]},
            "term_label": _term_label_expr(),
            "course_code": _course_code_expr(),
            "course_title": {"$ifNull": ["$course.course_title", ""]},
            "section_code": {"$ifNull": ["$section.section_code", ""]},
            "faculty_name": {
                "$cond": [
                    {"$gt": [{"$strLenCP": {"$ifNull": ["$fa.faculty_id", ""]}}, 0]},
                    _upper_last_first_from_user_expr(),
                    "UNASSIGNED"
                ]
            },
        }},
        {"$sort": {"course_code": 1, "section_code": 1}},
    ]
    return pipeline


async def _find_active_term() -> Optional[Dict[str, Any]]:
    """
    Return the WORKING / PLANNING term for Class Retention.

    Priority:
    1) If there is an active (non-archived) pre-enlistment batch in
       preenlistment_count, use that term_id.
    2) Otherwise, use the *next* term after the current term
       (where is_current/status flags it as current/active).
    3) If there is no "next" term configured, fall back to the current/latest term.
    """

    # 1) Try to derive from an active pre-enlistment batch
    pre_doc = await db[COL_PREEN_COUNT].find_one(
        {"is_archived": {"$ne": True}},
        {"_id": 0, "term_id": 1},
    )
    if pre_doc and pre_doc.get("term_id"):
        t = await db[COL_TERMS].find_one(
            {"term_id": pre_doc["term_id"]},
            {"_id": 0, "term_id": 1, "term_number": 1, "acad_year_start": 1},
        )
        if t:
            return t

    # 2) Fallback: "current" term (any of the usual flags)
    current = await db[COL_TERMS].find_one(
        {
            "$or": [
                {"status": "active"},
                {"status": "Active"},
                {"is_current": True},
                {"is_active": True},
                {"active": True},
            ]
        },
        {"_id": 0, "term_id": 1, "term_number": 1, "acad_year_start": 1},
    )

    if not current:
        # If nothing is flagged, use the latest by AY + term_number
        last = await db[COL_TERMS].find(
            {}, {"_id": 0, "term_id": 1, "term_number": 1, "acad_year_start": 1},
        ).sort([("acad_year_start", -1), ("term_number", -1)]).limit(1).to_list(1)
        current = last[0] if last else None

    if not current:
        # No terms at all
        return None

    # 3) Compute the "next" term after the current term
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
        {"_id": 0, "term_id": 1, "term_number": 1, "acad_year_start": 1},
    ).sort([("acad_year_start", 1), ("term_number", 1)]).limit(1).to_list(1)

    if next_terms:
        # Use the next term as the working/planning term
        return next_terms[0]

    # If no next term, stick with current (still better than nothing)
    return current

def _to_int_or_none(v) -> Optional[int]:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except Exception:
        raise HTTPException(status_code=400, detail="enrolled must be an integer")


async def _derive_faculty_for_section(section_id: Optional[str]) -> Optional[str]:
    """Return faculty_id from latest non-archived assignment for the section."""
    if not section_id:
        return None
    fa = await db[COL_FAC_ASSIGN].find_one(
        {"section_id": section_id, "is_archived": {"$ne": True}},
        sort=[("created_at", -1)]
    )
    return fa.get("faculty_id") if fa else None


async def _course_units_for_course(course_id: Optional[str]) -> Dict[str, Optional[int]]:
    """Return canonical student/faculty units for a course.

    - student_units comes from courses.units
    - faculty_units comes from courses.faculty_units (fallback 3)
    """
    cid = str(course_id or "").strip()
    if not cid:
        raise HTTPException(status_code=400, detail="course_id is required")

    course = await db[COL_COURSES].find_one(
        {"course_id": cid},
        {"_id": 0, "course_id": 1, "units": 1, "faculty_units": 1},
    )
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")

    student_units = _to_int_or_none(course.get("units"))
    faculty_units = _to_int_or_none(course.get("faculty_units"))
    if faculty_units is None:
        faculty_units = 3

    return {"student_units": student_units, "faculty_units": faculty_units}


@router.get("/classretention")
async def cr_get(
    action: str = Query(...),
    term_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    course_id: Optional[str] = Query(None),  # for sectionOptions
):
    # --- page options (statuses, term list, active term label) ---
    if action == "options":
        cur = db[COL_TERMS].find(
            {}, {"_id": 0, "term_id": 1, "term_number": 1, "acad_year_start": 1}
        ).sort([("acad_year_start", -1), ("term_number", -1)])
        terms = await cur.to_list(length=5000)

        active = await _find_active_term()
        label = ""
        if active:
            ay = active.get("acad_year_start", 0)
            tn = active.get("term_number", "")
            label = f"Term {tn} · AY {ay}-{ay+1}"
        return {
            "ok": True,
            "statuses": STATUS_OPTIONS,
            "terms": [
                {
                    "term_id": t["term_id"],
                    "label": f"Term {t.get('term_number','')} · AY {t.get('acad_year_start','')}-{(t.get('acad_year_start') or 0)+1}",
                    "term_number": t.get("term_number"),
                    "acad_year_start": t.get("acad_year_start"),
                } for t in terms
            ],
            "activeTerm": active,
            "activeTermLabel": label,
        }

    # --- list table rows ---
    if action == "list":
        if not term_id:
            active = await _find_active_term()
            term_id = active.get("term_id") if active else None

        # If we still don't have a working term, do NOT show old rows
        if not term_id:
            return {"ok": True, "rows": []}

        rows = await db[COL_CLASS_RETENTION].aggregate(
            _list_pipeline(term_id, status, q)
        ).to_list(length=5000)
        return {"ok": True, "rows": rows}

    # --- dropdown helpers: course options for active term (courses that have sections this term) ---
    if action == "courseOptions":
        t = term_id
        if not t:
            active = await _find_active_term()
            t = active.get("term_id") if active else None
        if not t:
            return {"ok": True, "options": []}

        pipeline = [
            {"$match": {"term_id": t}},
            {"$group": {"_id": "$course_id"}},
            {"$lookup": {"from": COL_COURSES, "localField": "_id", "foreignField": "course_id", "as": "c"}},
            {"$unwind": {"path": "$c", "preserveNullAndEmptyArrays": True}},
            {"$project": {
                "_id": 0,
                "course_id": {"$ifNull": ["$c.course_id", "$_id"]},
                "course_code": {"$ifNull": ["$c.course_code", ""]},
                "course_title": {"$ifNull": ["$c.course_title", ""]},
                "units": {"$ifNull": ["$c.units", None]},
                "faculty_units": {"$ifNull": ["$c.faculty_units", 3]},
            }},
            {"$sort": {"course_code": 1}},
        ]
        opts = await db[COL_SECTIONS].aggregate(pipeline).to_list(length=5000)
        return {"ok": True, "options": opts}

    # --- dropdown helpers: section options by course for active term (includes faculty) ---
    if action == "sectionOptions":
        t = term_id
        if not t:
            active = await _find_active_term()
            t = active.get("term_id") if active else None
        if not t or not course_id:
            return {"ok": True, "options": []}

        pipeline = [
            {"$match": {"term_id": t, "course_id": course_id}},

            # latest non-archived faculty assignment per section
            {
                "$lookup": {
                    "from": COL_FAC_ASSIGN,
                    "let": {"sid": "$section_id"},
                    "pipeline": [
                        {"$match": {
                            "$expr": {
                                "$and": [
                                    {"$eq": ["$section_id", "$$sid"]},
                                    {"$ne": ["$is_archived", True]},
                                ]
                            }
                        }},
                        {"$sort": {"created_at": -1}},
                        {"$limit": 1},
                    ],
                    "as": "fa"
                }
            },
            {"$unwind": {"path": "$fa", "preserveNullAndEmptyArrays": True}},

            # faculty_profiles (limit 1) via pipeline lookup to avoid fan-out
            {
                "$lookup": {
                    "from": COL_FAC_PROFILES,
                    "let": {"fid": "$fa.faculty_id"},
                    "pipeline": [
                        {"$match": {"$expr": {"$eq": ["$faculty_id", "$$fid"]}}},
                        {"$sort": {"updated_at": -1}},
                        {"$limit": 1},
                    ],
                    "as": "fac"
                }
            },
            {"$unwind": {"path": "$fac", "preserveNullAndEmptyArrays": True}},

            # users (limit 1) via pipeline lookup; support userId and user_id
            {
                "$lookup": {
                    "from": COL_USERS,
                    "let": {"uid": "$fac.user_id"},
                    "pipeline": [
                        {
                            "$match": {
                                "$expr": {
                                    "$or": [
                                        {"$eq": ["$userId", "$$uid"]},
                                        {"$eq": ["$user_id", "$$uid"]},
                                    ]
                                }
                            }
                        },
                        {"$limit": 1},
                    ],
                    "as": "u",
                }
            },
            {"$unwind": {"path": "$u", "preserveNullAndEmptyArrays": True}},

            # shape
            {"$project": {
                "_id": 0,
                "section_id": 1,
                "section_code": 1,
                "enrolled": 1,
                "faculty_id": {"$ifNull": ["$fa.faculty_id", None]},
                "faculty_name": {
                    "$cond": [
                        {"$gt": [{"$strLenCP": {"$ifNull": ["$fa.faculty_id", ""]}}, 0]},
                        {
                            "$toUpper": {
                                "$concat": [
                                    {"$ifNull": ["$fac.last_name", {"$ifNull": ["$u.lastName", "$u.last_name"]} ]},
                                    ", ",
                                    {"$ifNull": ["$fac.first_name", {"$ifNull": ["$u.firstName", "$u.first_name"]}]},
                                ]
                            }
                        },
                        "UNASSIGNED"
                    ]
                },
            }},

            # SAFETY: collapse to one row per section_id in case any upstream join duplicates slipped through
            {"$group": {"_id": "$section_id", "doc": {"$first": "$$ROOT"}}},
            {"$replaceRoot": {"newRoot": "$doc"}},

            {"$sort": {"section_code": 1}},
        ]
        opts = await db[COL_SECTIONS].aggregate(pipeline).to_list(length=5000)
        return {"ok": True, "options": opts}

    # --- fallback ---
    raise HTTPException(status_code=400, detail="Unsupported action")


@router.post("/classretention")
async def cr_post(action: str = Query(...), userId: Optional[str] = Query(None), payload: Dict[str, Any] = Body(default={})):
    now = datetime.utcnow()

    if action == "save":
        rid = payload.get("retention_id")

        # normalize & validate enrolled
        if "enrolled" in payload:
            payload["enrolled"] = _to_int_or_none(payload.get("enrolled"))
            if payload["enrolled"] is not None and payload["enrolled"] < 0:
                raise HTTPException(status_code=400, detail="enrolled must be >= 0")

        # always ignore incoming faculty_id (auto-derived)
        if "faculty_id" in payload:
            payload.pop("faculty_id", None)

        # UPDATE
        if rid:
            try:
                _id = ObjectId(rid)
            except Exception:
                raise HTTPException(status_code=400, detail="Invalid retention_id")

            allowed = [
                "term_id", "course_id", "section_id",
                "student_units", "faculty_units", "status", "enrolled",
            ]
            update_doc = {k: payload[k] for k in allowed if k in payload}
            if "status" in update_doc:
                s = (update_doc.get("status") or "").strip()
                if s.lower() == "special class":
                    # Legacy alias support.
                    update_doc["status"] = "Convert to Special Class"
                if update_doc["status"] not in STATUS_OPTIONS:
                    raise HTTPException(status_code=400, detail="Invalid status")
            update_doc["updated_at"] = now
            # Load existing row to detect status transitions (for student broadcast).
            existing = await db[COL_CLASS_RETENTION].find_one(
                {"_id": _id},
                {"_id": 0, "term_id": 1, "course_id": 1, "section_id": 1, "status": 1, "enrolled": 1},
            )
            if not existing:
                raise HTTPException(status_code=404, detail="Retention row not found")

            prev_status = str(existing.get("status") or "").strip()
            prev_term_id = str(existing.get("term_id") or "").strip()
            prev_course_id = str(existing.get("course_id") or "").strip()
            prev_enrolled = existing.get("enrolled")

            course_id_for_units = update_doc.get("course_id") or existing.get("course_id")
            course_units = await _course_units_for_course(course_id_for_units)
            update_doc["student_units"] = course_units.get("student_units")
            update_doc["faculty_units"] = course_units.get("faculty_units")

            # derive faculty from (new/current) section
            section_id_for_fac = update_doc.get("section_id") or existing.get("section_id")

            derived_faculty_id = await _derive_faculty_for_section(section_id_for_fac)
            update_doc["faculty_id"] = derived_faculty_id

            try:
                out = await db[COL_CLASS_RETENTION].find_one_and_update(
                    {"_id": _id},
                    {"$set": update_doc},
                    return_document=ReturnDocument.AFTER,
                )
            except DuplicateKeyError:
                raise HTTPException(status_code=409, detail="A row for this term and section already exists.")
            if not out:
                raise HTTPException(status_code=404, detail="Retention row not found")

            # mirror enrolled → sections
            if "enrolled" in payload:
                section_id = section_id_for_fac
                if section_id:
                    await db[COL_SECTIONS].update_one(
                        {"section_id": section_id},
                        {"$set": {"enrolled": payload["enrolled"], "updated_at": now}},
                    )

            # If status is Dissolved, auto-write a marker into sections.remarks
            # so APO_CourseOfferings + OM_LoadAssignment can display it.
            status_effective = (update_doc.get("status") or prev_status or "").strip()
            await _ensure_section_remarks_tag(section_id_for_fac, status_effective, now)

            # Broadcast to ALL students only on transition to Dissolved (best-effort; in-app only).
            if prev_status.strip().lower() != "dissolved" and status_effective.strip().lower() == "dissolved":
                await _broadcast_dissolved_to_students(
                    term_id=prev_term_id or str(out.get("term_id") or ""),
                    course_id=prev_course_id or str(out.get("course_id") or ""),
                    section_id=str(section_id_for_fac or "").strip(),
                    enrolled=(payload.get("enrolled") if "enrolled" in payload else out.get("enrolled", prev_enrolled)),
                )

                await _notify_interested_students_dissolved(
                    term_id=prev_term_id or str(out.get("term_id") or ""),
                    course_id=prev_course_id or str(out.get("course_id") or ""),
                    section_id=str(section_id_for_fac or "").strip(),
                    enrolled=(payload.get("enrolled") if "enrolled" in payload else out.get("enrolled", prev_enrolled)),
                    email_from_user_id=(userId or None),
                )

                await _notify_apo_dissolved(
                    term_id=prev_term_id or str(out.get("term_id") or ""),
                    course_id=prev_course_id or str(out.get("course_id") or ""),
                    section_id=str(section_id_for_fac or "").strip(),
                    enrolled=(payload.get("enrolled") if "enrolled" in payload else out.get("enrolled", prev_enrolled)),
                    email_from_user_id=(userId or None),
                )

            return {"ok": True, "retention_id": rid}

        # CREATE
        for k in ("term_id", "course_id", "section_id"):
            if not payload.get(k):
                raise HTTPException(status_code=400, detail=f"{k} is required")

        status = payload.get("status", "Under Review")
        s = (status or "").strip()
        if s.lower() == "special class":
            # Legacy alias support.
            status = "Convert to Special Class"
        if status not in STATUS_OPTIONS:
            raise HTTPException(status_code=400, detail="Invalid status")

        course_units = await _course_units_for_course(payload.get("course_id"))
        derived_faculty_id = await _derive_faculty_for_section(payload.get("section_id"))

        doc = {
            "term_id": payload["term_id"],
            "course_id": payload["course_id"],
            "section_id": payload["section_id"],
            "faculty_id": derived_faculty_id,  # snapshot only; UI derives from assignments for display
            "student_units": course_units.get("student_units"),
            "faculty_units": course_units.get("faculty_units"),
            "status": status,
            "enrolled": payload.get("enrolled"),
            "created_at": now,
            "updated_at": now,
        }
        try:
            res = await db[COL_CLASS_RETENTION].insert_one(doc)
        except DuplicateKeyError:
            raise HTTPException(status_code=409, detail="A row for this term and section already exists.")

        # mirror enrolled → section
        if doc.get("enrolled") is not None:
            await db[COL_SECTIONS].update_one(
                {"section_id": doc["section_id"]},
                {"$set": {"enrolled": doc["enrolled"], "updated_at": now}},
            )

        # If status is Dissolved, auto-write a marker into sections.remarks
        # so APO_CourseOfferings + OM_LoadAssignment can display it.
        await _ensure_section_remarks_tag(doc.get("section_id"), doc.get("status") or "", now)

        # Broadcast to ALL students if created as Dissolved (best-effort; in-app only).
        if str(doc.get("status") or "").strip().lower() == "dissolved":
            await _broadcast_dissolved_to_students(
                term_id=str(doc.get("term_id") or ""),
                course_id=str(doc.get("course_id") or ""),
                section_id=str(doc.get("section_id") or ""),
                enrolled=doc.get("enrolled"),
            )

            await _notify_interested_students_dissolved(
                term_id=str(doc.get("term_id") or ""),
                course_id=str(doc.get("course_id") or ""),
                section_id=str(doc.get("section_id") or ""),
                enrolled=doc.get("enrolled"),
                email_from_user_id=(userId or None),
            )

            await _notify_apo_dissolved(
                term_id=str(doc.get("term_id") or ""),
                course_id=str(doc.get("course_id") or ""),
                section_id=str(doc.get("section_id") or ""),
                enrolled=doc.get("enrolled"),
                email_from_user_id=(userId or None),
            )

        return {"ok": True, "retention_id": str(res.inserted_id)}

    if action == "delete":
        rid = payload.get("retention_id")
        if not rid:
            raise HTTPException(status_code=400, detail="retention_id required")
        try:
            _id = ObjectId(rid)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid retention_id")
        await db[COL_CLASS_RETENTION].delete_one({"_id": _id})
        return {"ok": True}

    if action == "forward":
        ids = payload.get("ids") or []
        new_status = payload.get("to_status") or "Under Review"
        if new_status not in STATUS_OPTIONS:
            raise HTTPException(status_code=400, detail="Invalid status")
        obj_ids: List[ObjectId] = []
        for s in ids:
            try:
                obj_ids.append(ObjectId(s))
            except Exception:
                continue
        if not obj_ids:
            return {"ok": True, "matched": 0, "modified": 0}
        # Snapshot previous rows (best-effort) to detect Dissolved transitions.
        prev_rows = []
        try:
            prev_rows = await db[COL_CLASS_RETENTION].find(
                {"_id": {"$in": obj_ids}},
                {"_id": 0, "term_id": 1, "course_id": 1, "section_id": 1, "status": 1, "enrolled": 1},
            ).to_list(5000)
        except Exception:
            prev_rows = []

        res = await db[COL_CLASS_RETENTION].update_many(
            {"_id": {"$in": obj_ids}},
            {"$set": {"status": new_status, "updated_at": now}},
        )

        # If status is Dissolved, write marker + broadcast to all students (best-effort).
        if str(new_status or "").strip().lower() == "dissolved" and prev_rows:
            for r in prev_rows:
                prev_s = str((r or {}).get("status") or "").strip()
                if prev_s.lower() == "dissolved":
                    continue
                term_id = str((r or {}).get("term_id") or "").strip()
                course_id = str((r or {}).get("course_id") or "").strip()
                section_id = str((r or {}).get("section_id") or "").strip()
                if section_id:
                    await _ensure_section_remarks_tag(section_id, "Dissolved", now)
                    await _broadcast_dissolved_to_students(
                        term_id=term_id,
                        course_id=course_id,
                        section_id=section_id,
                        enrolled=(r or {}).get("enrolled"),
                    )

                    await _notify_interested_students_dissolved(
                        term_id=term_id,
                        course_id=course_id,
                        section_id=section_id,
                        enrolled=(r or {}).get("enrolled"),
                        email_from_user_id=(userId or None),
                    )

                    await _notify_apo_dissolved(
                        term_id=term_id,
                        course_id=course_id,
                        section_id=section_id,
                        enrolled=(r or {}).get("enrolled"),
                        email_from_user_id=(userId or None),
                    )

        return {"ok": True, "matched": res.matched_count, "modified": res.modified_count}

    raise HTTPException(status_code=400, detail="Unsupported action")
