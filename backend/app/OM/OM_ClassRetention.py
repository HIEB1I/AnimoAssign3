from __future__ import annotations

from datetime import datetime
import re
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Body
from pymongo import ASCENDING, ReturnDocument
from pymongo.errors import DuplicateKeyError
from bson import ObjectId

from ..main import db
from ..Notifications import create_notification

router = APIRouter(prefix="/om", tags=["om"])

# --- collections ---
COL_CLASS_RETENTION = "class_retention"
COL_TERMS = "terms"
COL_COURSES = "courses"
COL_SECTIONS = "sections"
COL_USERS = "users"
COL_FAC_PROFILES = "faculty_profiles"
COL_FAC_ASSIGN = "faculty_assignments"
COL_PREEN_COUNT = "preenlistment_count" 

STATUS_OPTIONS = ["Approved", "Under Review", "Dissolved"]


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

# --- Notifications: OM Class Retention -> APO ---------------------------------
# When OM marks a section as "Dissolved", APO should be notified via:
#   1) in-app bell (notifications collection)
#   2) Gmail (best-effort)
# We mirror the recipient-resolution logic from OM_LoadAssignment.
async def _resolve_actor_user_id(raw: str | None) -> str:
    """Resolve a possibly-ObjectId user identifier into canonical users.user_id."""
    s = str(raw or "").strip()
    if not s:
        return ""
    if s.upper().startswith("USR"):
        return s
    # Best-effort ObjectId -> users.user_id
    try:
        if len(s) == 24:
            oid = ObjectId(s)
            u = await db[COL_USERS].find_one({"_id": oid}, {"_id": 0, "user_id": 1})
            resolved = str((u or {}).get("user_id") or "").strip()
            return resolved or s
    except Exception:
        pass
    return s

# NOTE: Recipient resolution mirrors OM_LoadAssignment._apo_user_ids_for_campus
# and APO_CourseOfferings.apo_scope(). This is important because hardcoding a
# role_id (e.g., ROLE0004) is risky across deployments.

async def _apo_user_ids_for_campus(campus_id: str) -> list[str]:
    """Return APO user_ids scoped to the given campus (best-effort)."""

    campus_id = (campus_id or "").strip().upper()
    if not campus_id:
        return []

    # Prefer dynamic APO role_id from user_roles.
    ROLE_APO = ""
    try:
        role_doc = await db.get_collection("user_roles").find_one(
            {"role_type": {"$regex": "^APO$", "$options": "i"}},
            {"_id": 0, "role_id": 1},
        )
        ROLE_APO = str((role_doc or {}).get("role_id") or "").strip()
    except Exception:
        ROLE_APO = ""

    if not ROLE_APO:
        ROLE_APO = "ROLE0004"  # legacy fallback

    def _scope_has_campus(scope_val: Any) -> bool:
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

    # 1) role_assignments with campus scope (primary behavior)
    try:
        docs = (
            await db.get_collection("role_assignments")
            .find({"role_id": ROLE_APO}, {"_id": 0, "user_id": 1, "scope": 1})
            .to_list(None)
        )
    except Exception:
        docs = []

    for d in docs or []:
        uid = str((d or {}).get("user_id") or "").strip()
        if not uid:
            continue
        if _scope_has_campus((d or {}).get("scope")):
            out.add(uid)

    # 2) Legacy fallback: users.role field + users.campus_id
    try:
        cur = db.get_collection(COL_USERS).find(
            {"role": {"$regex": r"\bAPO\b", "$options": "i"}, "campus_id": campus_id},
            {"_id": 0, "user_id": 1},
        )
        async for u in cur:
            uid = str((u or {}).get("user_id") or "").strip()
            if uid:
                out.add(uid)
    except Exception:
        pass

    return sorted(list(out))


async def _all_apo_user_ids() -> list[str]:
    """Return all APO user_ids (best-effort)."""

    uids: set[str] = set()

    # 1) role_assignments for APO role
    try:
        apo_role = await db.get_collection("user_roles").find_one(
            {"role_type": {"$regex": "^APO$", "$options": "i"}},
            {"_id": 0, "role_id": 1},
        )
        apo_role_id = str((apo_role or {}).get("role_id") or "").strip()
        if apo_role_id:
            cur = db.get_collection("role_assignments").find(
                {"role_id": apo_role_id},
                {"_id": 0, "user_id": 1},
            )
            async for r in cur:
                uid = str((r or {}).get("user_id") or "").strip()
                if uid:
                    uids.add(uid)
    except Exception:
        pass

    # 2) legacy users.role field
    try:
        cur2 = db.get_collection(COL_USERS).find(
            {"role": {"$regex": r"\bAPO\b", "$options": "i"}},
            {"_id": 0, "user_id": 1},
        )
        async for r in cur2:
            uid = str((r or {}).get("user_id") or "").strip()
            if uid:
                uids.add(uid)
    except Exception:
        pass

    return sorted(uids)
def _fmt_course_code(course_doc: dict) -> str:
    cc = (course_doc or {}).get("course_code")
    if isinstance(cc, list):
        return str(cc[0] if cc else "").strip()
    return str(cc or "").strip()
async def _notify_apo_class_dissolved(*, term_id: str, course_id: str, section_id: str, enrolled: int | None, actor_user_id: str) -> None:
    """Send in-app + Gmail notification to APO users for a dissolved section."""

    # Fetch course + section info (best-effort)
    course = await db[COL_COURSES].find_one({"course_id": course_id}, {"_id": 0, "course_code": 1, "course_title": 1}) or {}
    sec = await db[COL_SECTIONS].find_one({"section_id": section_id}, {"_id": 0, "section_code": 1, "campus_id": 1, "enrolled": 1}) or {}

    course_code = _fmt_course_code(course)
    course_title = str(course.get("course_title") or "").strip()
    section_code = str(sec.get("section_code") or "").strip()
    campus_id = str(sec.get("campus_id") or "").strip()

    eff_enrolled = enrolled
    if eff_enrolled is None:
        try:
            eff_enrolled = int(sec.get("enrolled")) if sec.get("enrolled") is not None else None
        except Exception:
            eff_enrolled = None

    title = "Class dissolved (low enrollment)"
    details = (
        "OM marked this section as Dissolved due to low enrollment.\n\n"
        f"Course: {course_code}{(' — ' + course_title) if course_title else ''}\n"
        f"Section: {section_code or section_id}{(' (enrolled: ' + str(eff_enrolled) + ')') if eff_enrolled is not None else ''}"
    )

    meta = {
        "kind": "om_classretention_dissolved",
        "route": "/apo/courseofferings",
        "term_id": term_id,
        "course_id": course_id,
        "section_id": section_id,
        "campus_id": campus_id,
        "course_code": course_code,
        "section_code": section_code,
    }

    # Resolve APO recipients
    recipients = await _apo_user_ids_for_campus(campus_id) if campus_id else []
    if not recipients:
        recipients = await _all_apo_user_ids()

    # Send best-effort to all recipients
    for uid in recipients:
        try:
            await create_notification(
                user_id=uid,
                title=title,
                details=details,
                meta=meta,
                send_email=True,
                email_from_user_id=actor_user_id or None,
            )
        except Exception:
            # Best-effort: do not block save if notification fails
            pass

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
async def cr_post(
    action: str = Query(...),
    userId: Optional[str] = Query(None),
    user_id: Optional[str] = Query(None),
    payload: Dict[str, Any] = Body(default={}),
):
    now = datetime.utcnow()

    if action == "save":
        rid = payload.get("retention_id")

        # actor user id (used as Gmail sender when available)
        actor_user_id = await _resolve_actor_user_id(userId or user_id)

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

            # Load the current row so we can detect status transitions (e.g., Under Review -> Dissolved).
            existing_doc = await db[COL_CLASS_RETENTION].find_one(
                {"_id": _id},
                {"_id": 0, "status": 1, "term_id": 1, "course_id": 1, "section_id": 1, "enrolled": 1},
            ) or {}
            old_status = str(existing_doc.get("status") or "").strip()

            allowed = [
                "term_id", "course_id", "section_id",
                "student_units", "faculty_units", "status", "enrolled",
            ]
            update_doc = {k: payload[k] for k in allowed if k in payload}
            if "status" in update_doc:
                s = (update_doc.get("status") or "").strip()
                if s.lower() == "special class":
                    # Status removed; treat legacy value as Dissolved.
                    update_doc["status"] = "Dissolved"
                if update_doc["status"] not in STATUS_OPTIONS:
                    raise HTTPException(status_code=400, detail="Invalid status")
            update_doc["updated_at"] = now

            # derive faculty from (new/current) section
            section_id_for_fac = update_doc.get("section_id")
            existing_status = None
            if not section_id_for_fac:
                existing = await db[COL_CLASS_RETENTION].find_one(
                    {"_id": _id},
                    {"_id": 0, "section_id": 1, "status": 1},
                )
                section_id_for_fac = existing.get("section_id") if existing else None
                existing_status = existing.get("status") if existing else None

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
            status_effective = (update_doc.get("status") or existing_status or "").strip()
            await _ensure_section_remarks_tag(section_id_for_fac, status_effective, now)

            # Notify APO when transitioning into Dissolved
            try:
                if old_status.strip().lower() != 'dissolved' and status_effective.strip().lower() == 'dissolved':
                    await _notify_apo_class_dissolved(
                        term_id=str(out.get('term_id') or update_doc.get('term_id') or existing_doc.get('term_id') or ''),
                        course_id=str(out.get('course_id') or update_doc.get('course_id') or existing_doc.get('course_id') or ''),
                        section_id=str(section_id_for_fac or out.get('section_id') or existing_doc.get('section_id') or ''),
                        enrolled=payload.get('enrolled') if 'enrolled' in payload else existing_doc.get('enrolled'),
                        actor_user_id=actor_user_id,
                    )
            except Exception:
                pass
            return {"ok": True, "retention_id": rid}

        # CREATE
        for k in ("term_id", "course_id", "section_id"):
            if not payload.get(k):
                raise HTTPException(status_code=400, detail=f"{k} is required")

        status = payload.get("status", "Under Review")
        s = (status or "").strip()
        if s.lower() == "special class":
            # Status removed; treat legacy value as Dissolved.
            status = "Dissolved"
        if status not in STATUS_OPTIONS:
            raise HTTPException(status_code=400, detail="Invalid status")

        derived_faculty_id = await _derive_faculty_for_section(payload.get("section_id"))

        doc = {
            "term_id": payload["term_id"],
            "course_id": payload["course_id"],
            "section_id": payload["section_id"],
            "faculty_id": derived_faculty_id,  # snapshot only; UI derives from assignments for display
            "student_units": payload.get("student_units"),
            "faculty_units": payload.get("faculty_units"),
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

        # Notify APO if the row is created as Dissolved
        try:
            if str(doc.get('status') or '').strip().lower() == 'dissolved':
                await _notify_apo_class_dissolved(
                    term_id=str(doc.get('term_id') or ''),
                    course_id=str(doc.get('course_id') or ''),
                    section_id=str(doc.get('section_id') or ''),
                    enrolled=doc.get('enrolled'),
                    actor_user_id=actor_user_id,
                )
        except Exception:
            pass

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

        actor_user_id = await _resolve_actor_user_id(userId or user_id)

        obj_ids: List[ObjectId] = []
        for s in ids:
            try:
                obj_ids.append(ObjectId(s))
            except Exception:
                continue
        if not obj_ids:
            return {"ok": True, "matched": 0, "modified": 0}

        # Fetch current docs so we can detect transitions to Dissolved
        docs = await db[COL_CLASS_RETENTION].find(
            {"_id": {"$in": obj_ids}},
            {"_id": 1, "status": 1, "term_id": 1, "course_id": 1, "section_id": 1, "enrolled": 1},
        ).to_list(None)

        res = await db[COL_CLASS_RETENTION].update_many(
            {"_id": {"$in": obj_ids}},
            {"$set": {"status": new_status, "updated_at": now}},
        )

        # Write section remarks + notify APO only for transitions into Dissolved
        if str(new_status).strip().lower() == "dissolved":
            for d in docs or []:
                old_status = str((d or {}).get("status") or "").strip().lower()
                if old_status == "dissolved":
                    continue
                sid = str((d or {}).get("section_id") or "").strip()
                if sid:
                    await _ensure_section_remarks_tag(sid, "Dissolved", now)
                try:
                    await _notify_apo_class_dissolved(
                        term_id=str((d or {}).get("term_id") or ""),
                        course_id=str((d or {}).get("course_id") or ""),
                        section_id=sid,
                        enrolled=(d or {}).get("enrolled"),
                        actor_user_id=actor_user_id,
                    )
                except Exception:
                    pass

        return {"ok": True, "matched": res.matched_count, "modified": res.modified_count}

    raise HTTPException(status_code=400, detail="Unsupported action")
