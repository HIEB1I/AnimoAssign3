from datetime import datetime
from typing import Any, Dict, List, Optional, Literal
import re
from fastapi import APIRouter, HTTPException, Query, Body
from pymongo import ReturnDocument
from ..Notifications import create_notification

from ..main import db  # Motor/Mongo client

router = APIRouter(prefix="/apo", tags=["apo"])

# ----------------------------
# Collections
# ----------------------------
COL_COUNT = "preenlistment_count"
COL_STATS = "preenlistment_statistics"
COL_TERMS = "terms"
COL_COURSES = "courses"
COL_PROGRAMS = "programs"
COL_CAMPUSES = "campuses"
COL_COLLEGES = "colleges"
COL_ROLE_ASSIGNMENTS = "role_assignments"
COL_COUNTERS = "counters"
COL_USER_ROLES = "user_roles"
COL_STAFF_PROFILES = "staff_profiles"
COL_FACULTY_PROFILES = "faculty_profiles"
COL_CURRICULUM = "curriculum"

ACTIVE_Q = {"$ne": True}  # is_archived != True
ARCH_Q = True


# ----------------------------
# Helpers
# ----------------------------
def _now() -> datetime:
    return datetime.utcnow()


def _format_seq(prefix: str, n: int) -> str:
    s = str(n)
    if len(s) < 4:
        s = s.zfill(4)
    return f"{prefix}{s}"


async def _next_id(prefix: str, counter_key: str) -> str:
    doc = await db[COL_COUNTERS].find_one_and_update(
        {"_id": counter_key},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    return _format_seq(prefix, int(doc.get("seq", 1)))


def _norm_campus_name(c: Optional[str]) -> Optional[str]:
    if not c:
        return None
    s = str(c).strip().upper()
    if s in ("MANILA", "LAGUNA"):
        return s
    return None


def _ay_label(ay_start: Optional[int | str]) -> str:
    if ay_start is None:
        return "AY —"
    try:
        y = int(str(ay_start))
        return f"AY {y}-{y+1}"
    except Exception:
        return "AY —"


async def _term_meta(term_id: str) -> Dict[str, Any]:
    t = await db[COL_TERMS].find_one(
        {"term_id": term_id},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1, "is_current": 1},
    )
    if not t:
        return {"term_id": term_id, "ay_label": "AY —"}
    return {
        "term_id": t["term_id"],
        "acad_year_start": t.get("acad_year_start"),
        "term_number": t.get("term_number"),
        "is_current": t.get("is_current", False),
        "ay_label": _ay_label(t.get("acad_year_start")),
    }



def _dedupe(ids: List[str]) -> List[str]:
    out: List[str] = []
    seen = set()
    for x in ids or []:
        if not x:
            continue
        s = str(x).strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def _term_display(meta: Dict[str, Any]) -> str:
    tn = meta.get("term_number")
    ay = meta.get("ay_label") or _ay_label(meta.get("acad_year_start"))
    if tn:
        return f"Term {tn}, {ay}"
    return str(ay or "AY —")


async def _user_ids_by_role_regex(role_regex: str) -> List[str]:
    # role_regex can be a normal regex string, e.g. r"faculty" or r"(^OM$|Office Manager)"
    role_ids = [
        r.get("role_id")
        async for r in db[COL_USER_ROLES].find(
            {"role_type": {"$regex": role_regex, "$options": "i"}},
            {"_id": 0, "role_id": 1},
        )
    ]
    role_ids = [rid for rid in role_ids if rid]
    if not role_ids:
        return []
    user_ids = [
        ra.get("user_id")
        async for ra in db[COL_ROLE_ASSIGNMENTS].find(
            {"role_id": {"$in": role_ids}},
            {"_id": 0, "user_id": 1},
        )
    ]
    return _dedupe([u for u in user_ids if u])


async def _chair_user_ids() -> List[str]:
    # Prefer staff_profiles position_title, fallback to roles
    staff = [
        s.get("user_id")
        async for s in db[COL_STAFF_PROFILES].find(
            {"position_title": {"$regex": "chair", "$options": "i"}},
            {"_id": 0, "user_id": 1},
        )
    ]
    staff = _dedupe([u for u in staff if u])
    if staff:
        return staff
    return await _user_ids_by_role_regex("chair")


async def _faculty_user_ids() -> List[str]:
    uids = await _user_ids_by_role_regex("faculty")
    if uids:
        return uids
    # fallback: faculty_profiles
    fps = [
        f.get("user_id")
        async for f in db[COL_FACULTY_PROFILES].find({}, {"_id": 0, "user_id": 1})
    ]
    return _dedupe([u for u in fps if u])


async def _om_user_ids() -> List[str]:
    # Some seeds use 'OM', others 'Office Manager'
    uids = await _user_ids_by_role_regex(r"(^OM$|Office Manager)")
    if uids:
        return uids
    # fallback: staff_profiles position_title
    staff = [
        s.get("user_id")
        async for s in db[COL_STAFF_PROFILES].find(
            {"position_title": {"$regex": "office manager|\bom\b", "$options": "i"}},
            {"_id": 0, "user_id": 1},
        )
    ]
    staff = _dedupe([u for u in staff if u])
    if staff:
        return staff
    return await _user_ids_by_role_regex("om")

async def _notify_planning_started(*, actor_user_id: str, planning_term_id: str) -> Dict[str, Any]:
    """Notify OM + Chair + Faculty that course offerings planning started."""
    actor_campus = await _apo_campus_label_for_user(actor_user_id)
    actor_label = f"APO ({actor_campus})" if actor_campus else "APO"

    plan_meta = await _term_meta(planning_term_id)
    plan_label = _term_display(plan_meta)

    title = "Course Offerings Planning Started"
    details = f"{actor_label} archived pre-enlistment. Planning for course offerings for {plan_label} has started."

    om_ids = await _om_user_ids()
    chair_ids = await _chair_user_ids()
    faculty_ids = await _faculty_user_ids()

    om_set = set(om_ids)
    chair_set = set(chair_ids)

    all_ids = _dedupe(om_ids + chair_ids + faculty_ids)

    created = 0
    for uid in all_ids:
        if uid == actor_user_id:
            continue
        route = "/faculty/overview"
        if uid in om_set:
            route = "/om/home/load-assignment"
        elif uid in chair_set:
            route = "/chair/plantilla"

        meta = {"route": route, "kind": "preenlistment_archived", "term_id": planning_term_id}
        await create_notification(
            user_id=uid,
            title=title,
            details=details,
            meta=meta,
            send_email=True,
            email_from_user_id=actor_user_id,
        )
        created += 1

    return {"created": created, "recipients": all_ids}

async def _active_term_id() -> Optional[str]:
    t = await db[COL_TERMS].find_one({"is_current": True}, {"_id": 0, "term_id": 1})
    return t["term_id"] if t else None


async def _next_term_id(current_tid: str) -> Optional[str]:
    cur = await db[COL_TERMS].find_one(
        {"term_id": current_tid},
        {"_id": 0, "acad_year_start": 1, "term_number": 1},
    )
    if not cur:
        return None
    ay = cur.get("acad_year_start")
    tn = int(cur.get("term_number") or 0)

    nxt = await db[COL_TERMS].find_one(
        {"acad_year_start": ay, "term_number": tn + 1},
        {"_id": 0, "term_id": 1},
    )
    if nxt:
        return nxt["term_id"]

    nxt2 = await db[COL_TERMS].find_one(
        {"acad_year_start": (ay or 0) + 1, "term_number": 1},
        {"_id": 0, "term_id": 1},
    )
    return nxt2["term_id"] if nxt2 else None

# ------------ term helpers (shared by preenlistment + course offerings) ------------
async def _get_current_term_doc() -> Dict[str, Any]:
    """
    Returns the term document where is_current=True.
    This is the term where classes are currently running.
    """
    term = await db[COL_TERMS].find_one(
        {"is_current": True},
        {"term_id": 1, "acad_year_start": 1, "term_number": 1},
    )
    if not term:
        raise HTTPException(
            status_code=500,
            detail="No current term (is_current=True) in terms collection",
        )
    return term


async def _get_next_term_doc(base: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Given a 'base' term (normally the one with is_current=True),
    return the *next* term chronologically.

    If there is no later term configured, we fall back to 'base'
    so the system still works.
    """
    if base is None:
        base = await _get_current_term_doc()

    cursor = db[COL_TERMS].find(
        {
            "$or": [
                # same AY, higher term_number
                {
                    "acad_year_start": base["acad_year_start"],
                    "term_number": {"$gt": base["term_number"]},
                },
                # or any later AY
                {"acad_year_start": {"$gt": base["acad_year_start"]}},
            ]
        },
        {"term_id": 1, "acad_year_start": 1, "term_number": 1},
        sort=[("acad_year_start", 1), ("term_number", 1)],
    )

    next_terms = await cursor.to_list(length=1)
    if not next_terms:
        # No future term configured: reuse base so we don't crash
        return base

    return next_terms[0]


async def _get_planning_term_doc() -> Dict[str, Any]:
    """
    Term used for PLANNING (Preenlistment + Course Offerings).

    Rule: planning term = the NEXT term after the one with is_current=True.
    Example: if TERM0014 has is_current=True, planning term is TERM0015.
    """
    base = await _get_current_term_doc()
    return await _get_next_term_doc(base)

# NEW helper: get the term immediately *before* a given base term
async def _get_prev_term_doc(base: Dict[str, Any]) -> Dict[str, Any]:
    """
    Return the term immediately *before* `base` in chronological order.
    If there is no earlier term, returns `base` itself.
    """
    cursor = db[COL_TERMS].find(
        {
            "$or": [
                {
                    "acad_year_start": base["acad_year_start"],
                    "term_number": {"$lt": base["term_number"]},
                },
                {
                    "acad_year_start": {"$lt": base["acad_year_start"]},
                },
            ]
        },
        {"term_id": 1, "acad_year_start": 1, "term_number": 1},
        sort=[("acad_year_start", -1), ("term_number", -1)],
    )

    prev_terms = await cursor.to_list(length=1)
    if not prev_terms:
        return base
    return prev_terms[0]

# NEW: planning term for APO (same idea as Course Offerings)
async def _planning_term_id() -> Optional[str]:
    """
    For APO pre-enlistment, use the *next* term after the current active term.

    Example:
      - Active term (current)   → TERM0014 (Term 2)
      - Planning pre-enlistment → TERM0015 (Term 3)

    If there is no “next” term yet, fall back to the current active term.
    """
    try:
        planning = await _get_planning_term_doc()
    except HTTPException:
        # No term at all configured
        return None
    return planning.get("term_id")

async def _campus_by_name(name: Optional[str]) -> Optional[Dict[str, Any]]:
    if not name:
        return None
    s = str(name).strip()
    return await db[COL_CAMPUSES].find_one(
        {"$or": [{"campus_name": s}, {"campus_name": s.upper()}, {"campus_name": s.capitalize()}]},
        {"_id": 0, "campus_id": 1, "campus_name": 1},
    )


async def _course_by_code(code: str) -> Optional[Dict[str, Any]]:
    c = (code or "").strip().upper()
    if not c:
        return None
    doc = await db[COL_COURSES].find_one(
        {
            "$or": [
                {"course_code": c},
                {"course_code": {"$in": [c]}},
                {"course_code": {"$elemMatch": {"$regex": f"^{c}$", "$options": "i"}}},
            ]
        },
        {"_id": 0, "course_id": 1, "course_code": 1, "college_id": 1},
    )
    if not doc:
        return None
    cc = doc.get("course_code")
    if isinstance(cc, list):
        doc["course_code"] = cc[0] if cc else ""
    return doc

async def _college_by_code(code: Optional[str]) -> Optional[Dict[str, Any]]:
    if not code:
        return None
    c = str(code).strip().upper()
    return await db["colleges"].find_one(
        {"college_code": {"$regex": f"^{c}$", "$options": "i"}},
        {"_id": 0, "college_id": 1, "college_code": 1},
    )

def _normalize_prog_code_for_regex(p: str) -> str:
    # Collapse whitespace and escape regex specials so "BSCS (CBL)" matches literally
    s = re.sub(r"\s+", " ", (p or "").strip())
    specials = r".^$*+?{}[]\|()"
    esc = "".join([f"\\{ch}" if ch in specials else ch for ch in s])
    return esc

async def _program_by_code(program_code: str) -> Optional[Dict[str, Any]]:
    code = (program_code or "").strip()
    if not code:
        return None
    pat = _normalize_prog_code_for_regex(code)
    return await db[COL_PROGRAMS].find_one(
        {"program_code": {"$regex": f"^{pat}$", "$options": "i"}},
        {"_id": 0, "program_id": 1, "program_code": 1, "campus_id": 1},
    )


async def _apo_campus_label_for_user(user_id: str) -> Optional[str]:
    ra = await db[COL_ROLE_ASSIGNMENTS].find_one({"user_id": user_id}, {"_id": 0, "scope": 1})
    if not ra:
        return None
    scope = ra.get("scope") or []
    if isinstance(scope, dict):
        scope = [scope]
    campus_id = None
    for s in scope:
        if isinstance(s, dict) and str(s.get("type", "")).lower() == "campus":
            campus_id = s.get("id")
            break
    if not campus_id:
        return None
    camp = await db[COL_CAMPUSES].find_one({"campus_id": campus_id}, {"_id": 0, "campus_name": 1})
    name = (camp or {}).get("campus_name")
    if not name:
        return None
    n = str(name).strip().upper()
    if n == "MANILA":
        return "Manila"
    if n == "LAGUNA":
        return "Laguna"
    return name


def _career_to_program_level(career: str) -> Optional[str]:
    """
    Map CSV 'Career' to internal program_level labels.

    Requirements:
    - UGS == Undergraduate (this CSV uses UGS, not UGB)
    - GSM == Graduate Studies

    We also accept a few common variants for robustness.
    """
    c = (career or "").strip().upper()
    if c in {"UGS", "UGB", "UG", "UNDERGRAD", "UNDERGRADUATE"}:
        return "Undergraduate"
    if c in {"GSM", "GS", "GRAD", "GRADUATE", "GRADUATE STUDIES"}:
        return "Graduate Studies"
    return None

# ----------------------------
# Routes
# ----------------------------
@router.get("/preenlistment")
async def preenlistment_get(
    userId: str = Query(..., min_length=3),
    termId: Optional[str] = Query(None),
    scope: Literal["active", "archive", "archivesMeta"] = Query("active"),
    campus: Optional[str] = Query(None, description="Campus name, e.g., MANILA or LAGUNA"),
):
    """
    Fetch COUNT + STATS. Campus-scoped when campus is resolvable.
    """
    campus_uc = _norm_campus_name(campus)
    campus_label = "Manila" if campus_uc == "MANILA" else ("Laguna" if campus_uc == "LAGUNA" else None)
    if not campus_label:
        campus_label = await _apo_campus_label_for_user(userId)
        campus_uc = _norm_campus_name(campus_label)

    campus_id_for_filter: Optional[str] = None
    if campus_uc:
        camp = await _campus_by_name(campus_uc)
        campus_id_for_filter = (camp or {}).get("campus_id")

    if scope == "active" and not termId:
        # Active Pre-Enlistment should follow the PLANNING term:
        # the NEXT term after the one with is_current = True.
        termId = await _planning_term_id()
        if not termId:
            # Fallback: if we cannot resolve a planning term,
            # at least fall back to the current term.
            termId = await _active_term_id()
        if not termId:
            return {
                "count": [],
                "statistics": [],
                "meta": {
                    "term_id": "",
                    "ay_label": "AY —",
                    "campus_label": campus_label,
                },
            }

    if scope in ("active", "archive"):
        arch_val = (scope == "archive")
        if scope == "archive" and not termId:
            raise HTTPException(status_code=400, detail="termId is required for archive scope.")

        # COUNT
        count_match: Dict[str, Any] = {"term_id": termId, "is_archived": arch_val}
        if campus_id_for_filter:
            count_match["campus_id"] = campus_id_for_filter

        count_pipeline: List[Dict[str, Any]] = [
            {"$match": count_match},
            {"$lookup": {"from": COL_TERMS, "localField": "term_id", "foreignField": "term_id", "as": "term"}},
            {"$unwind": {"path": "$term", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": COL_COLLEGES, "localField": "college_id", "foreignField": "college_id", "as": "college"}},
            {"$unwind": {"path": "$college", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": COL_CAMPUSES, "localField": "campus_id", "foreignField": "campus_id", "as": "campus"}},
            {"$unwind": {"path": "$campus", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": COL_COURSES, "localField": "course_id", "foreignField": "course_id", "as": "course"}},
            {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
            {
                "$addFields": {
                    # course_code may be array/string
                    "course_code_display": {
                        "$cond": [
                            {"$isArray": "$course.course_code"},
                            {"$ifNull": [{"$arrayElemAt": ["$course.course_code", 0]}, ""]},
                            {"$ifNull": ["$course.course_code", ""]},
                        ]
                    },
                    # CSV "Acad Group" wins if present, otherwise college_code
                    "acad_group_display": {
                        "$ifNull": ["$acad_group_code", "$college.college_code"]
                    },
                    # CSV Career (UGB/GSM) is what we show, but also we keep program_level (mapped)
                    "career_display": {"$ifNull": ["$career", ""]},
                }
            },
            {
                "$project": {
                    "_id": 0,
                    "count_id": 1,
                    "term_id": 1,
                    "college_id": 1,
                    "campus_id": 1,
                    "course_id": 1,
                    "preenlistment_code": 1,
                    "career": "$career_display",
                    "preenlistment_count": 1,
                    "is_archived": 1,
                    "created_at": 1,
                    "updated_at": 1,
                    "terms.term_number": "$term.term_number",
                    "terms.acad_year_start": "$term.acad_year_start",
                    "colleges.college_code": "$college.college_code",
                    "campuses.campus_name": "$campus.campus_name",
                    "courses.course_code": "$course_code_display",
                    "acad_group": "$acad_group_display",
                }
            },
            {"$sort": {"updated_at": -1, "created_at": -1}},
        ]
        count_rows = [r async for r in db[COL_COUNT].aggregate(count_pipeline)]

        def to_count_view(r: Dict[str, Any]) -> Dict[str, Any]:
            # Coerce numeric safely
            try:
                cnt = int(r.get("preenlistment_count", 0) or 0)
            except Exception:
                cnt = 0
            return {
                "count_id": r.get("count_id", ""),
                "term_id": r.get("term_id", ""),
                "college_id": r.get("college_id"),
                "campus_id": r.get("campus_id"),
                "course_id": r.get("course_id"),
                "preenlistment_code": r.get("preenlistment_code", ""),
                "career": r.get("career", ""),
                "count": cnt,
                "is_archived": r.get("is_archived", False),
                "created_at": r.get("created_at"),
                "updated_at": r.get("updated_at"),
                "term_number": (r.get("terms") or {}).get("term_number"),
                "acad_year_start": (r.get("terms") or {}).get("acad_year_start"),
                "college_code": (r.get("colleges") or {}).get("college_code"),
                "campus_name": (r.get("campuses") or {}).get("campus_name"),
                "course_code": (r.get("courses") or {}).get("course_code", ""),
                "acad_group": r.get("acad_group") or "",
            }

        # STATS
        stats_match: Dict[str, Any] = {"term_id": termId, "is_archived": arch_val}
        if campus_id_for_filter:
            stats_match["campus_id"] = campus_id_for_filter

        stats_pipeline: List[Dict[str, Any]] = [
            {"$match": stats_match},
            {"$lookup": {"from": COL_TERMS, "localField": "term_id", "foreignField": "term_id", "as": "term"}},
            {"$unwind": {"path": "$term", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": COL_PROGRAMS, "localField": "program_id", "foreignField": "program_id", "as": "program"}},
            {"$unwind": {"path": "$program", "preserveNullAndEmptyArrays": True}},
            {
                "$project": {
                    "_id": 0,
                    "stat_id": 1,
                    "term_id": 1,
                    "program_id": 1,
                    "campus_id": 1,
                    "enrollment": 1,
                    "freshman": 1,
                    "sophomore": 1,
                    "junior": 1,
                    "senior": 1,
                    "is_archived": 1,
                    "created_at": 1,
                    "updated_at": 1,
                    "terms.term_number": "$term.term_number",
                    "terms.acad_year_start": "$term.acad_year_start",
                    "programs.program_code": "$program.program_code",
                }
            },
            {"$sort": {"updated_at": -1, "created_at": -1}},
        ]
        stats_rows = [r async for r in db[COL_STATS].aggregate(stats_pipeline)]

        meta = await _term_meta(termId)
        meta["campus_label"] = campus_label

        if scope == "active":
            return {"count": [to_count_view(x) for x in count_rows], "statistics": stats_rows, "meta": meta}
        else:
            return {"count": [to_count_view(x) for x in count_rows], "statistics": stats_rows, "archiveMeta": meta}

    if scope == "archivesMeta":
        count_terms_q: Dict[str, Any] = {"is_archived": ARCH_Q}
        stats_terms_q: Dict[str, Any] = {"is_archived": ARCH_Q}
        if campus:
            camp_doc = await _campus_by_name(_norm_campus_name(campus))
            cid = (camp_doc or {}).get("campus_id")
            if cid:
                count_terms_q["campus_id"] = cid
                stats_terms_q["campus_id"] = cid

        user_terms = await db[COL_COUNT].distinct("term_id", count_terms_q)
        stat_terms = await db[COL_STATS].distinct("term_id", stats_terms_q)
        tids = sorted(set([t for t in user_terms if t]) | set([t for t in stat_terms if t]))

        items: List[Dict[str, Any]] = []
        for tid in tids:
            meta = await _term_meta(tid)
            cc_q = {"term_id": tid, "is_archived": ARCH_Q}
            ss_q = {"term_id": tid, "is_archived": ARCH_Q}
            if campus:
                camp_doc = await _campus_by_name(_norm_campus_name(campus))
                cid = (camp_doc or {}).get("campus_id")
                if cid:
                    cc_q["campus_id"] = cid
                    ss_q["campus_id"] = cid
            items.append({
                "term_id": tid,
                "term_number": meta.get("term_number"),
                "ay_label": meta.get("ay_label", "AY —"),
                "courses": await db[COL_COUNT].count_documents(cc_q),
                "programs": await db[COL_STATS].count_documents(ss_q),
            })
        items.sort(key=lambda x: x["term_id"], reverse=True)
        return {"archives": items}

    raise HTTPException(status_code=400, detail="Invalid scope")


@router.post("/preenlistment")
async def preenlistment_post(
    userId: str = Query(..., min_length=3),
    termId: Optional[str] = Query(None),
    action: Literal["import", "archive", "reactivate"] = Query("import"),  # ← add "reactivate"
    replaceCount: bool = Query(False),
    replaceStats: bool = Query(False),
    campus: Optional[str] = Query(None, description="Campus name, e.g., MANILA or LAGUNA"),
    payload: Dict[str, Any] = Body({}, description="For action=import: {countRows, statRows}"),
):
    """
    Import/Archive with campus isolation + display-field guarantees.
    - Counts: keep CSV 'Career' (UGB/GSM) for display; also map to program_level internally.
    - Acad Group: display CSV 'Acad Group' (e.g., CCS) when provided, else fallback to college_code.
    - Statistics: robust program_code lookup (handles 'BSCS (CBL)' and similar).
    """
    campus_uc = _norm_campus_name(campus)
    campus_id_for_filter: Optional[str] = None  # ← NEW: always define this once

    if action == "archive":
        if not termId:
            # Archive the same PLANNING term shown in the Active view
            termId = await _planning_term_id()
            if not termId:
                termId = await _active_term_id()
        if not termId:
            raise HTTPException(
                status_code=400,
                detail="No term to archive (no active/planning term found).",
            )

        if not campus_uc:
            campus_label = await _apo_campus_label_for_user(userId)
            campus_uc = _norm_campus_name(campus_label)

        if campus_uc:
            camp_doc = await _campus_by_name(campus_uc)
            campus_id_for_filter = (camp_doc or {}).get("campus_id")

        if not campus_id_for_filter:
            raise HTTPException(
                status_code=400,
                detail="Cannot resolve campus; pass campus=MANILA|LAGUNA.",
            )

        # archive BOTH Manila + Laguna rows for the term (not just the caller campus)
        manila_doc = await _campus_by_name("MANILA")
        laguna_doc = await _campus_by_name("LAGUNA")
        both_campus_ids = [
            cid for cid in [
                (manila_doc or {}).get("campus_id"),
                (laguna_doc or {}).get("campus_id"),
            ]
            if cid
        ]

        # Fallback: if campuses not found for some reason, keep old behavior
        if not both_campus_ids:
            both_campus_ids = [campus_id_for_filter]

        count_q = {
            "term_id": termId,
            "is_archived": False,
            "campus_id": {"$in": both_campus_ids},
        }
        stats_q = {
            "term_id": termId,
            "is_archived": False,
            "campus_id": {"$in": both_campus_ids},
        }

        # 1) Archive all active rows for the planning term (per campus)
        upd1 = await db[COL_COUNT].update_many(
            count_q,
            {"$set": {"is_archived": True, "updated_at": _now()}},
        )
        upd2 = await db[COL_STATS].update_many(
            stats_q,
            {"$set": {"is_archived": True, "updated_at": _now()}},
        )

        # 2) Promote this planning term to be the new current term
        prev_active_tid = await _active_term_id()

        term_doc = await db[COL_TERMS].find_one(
            {"term_id": termId},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        )
        if not term_doc:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown termId {termId!r} for archive operation.",
            )

        if prev_active_tid != termId:
            await db[COL_TERMS].update_many({}, {"$set": {"is_current": False}})
            await db[COL_TERMS].update_one(
                {"term_id": termId},
                {"$set": {"is_current": True}},
            )

        new_current_tid = termId

        # 3) Compute the next planning term after this one
        next_term_doc = await _get_next_term_doc(term_doc)
        new_planning_tid = next_term_doc.get("term_id", termId)

        # Notify OM + Chair + Faculty that Course Offerings planning has started for the next term
        notif_created = 0
        try:
            notif_res = await _notify_planning_started(actor_user_id=userId, planning_term_id=new_planning_tid)
            notif_created = int((notif_res or {}).get("created") or 0)
        except Exception:
            # Best-effort notification; do not block archive
            pass


        return {
            "ok": True,
            "notifCreated": notif_created,
            "archivedCounts": upd1.modified_count,
            "archivedStats": upd2.modified_count,
            "previousActiveTermId": prev_active_tid,
            # newActiveTermId now means "new current term" after promotion
            "newActiveTermId": new_current_tid,
            # this is the term the Pre-Enlistment screen should show next
            "newPlanningTermId": new_planning_tid,
            "archivedTermId": termId,  # helpful for debugging, UI can ignore
        }
    
    if action == "reactivate":
        if not termId:
            raise HTTPException(status_code=400, detail="termId is required to reactivate.")

        campus_uc = _norm_campus_name(campus)
        if not campus_uc:
            campus_label = await _apo_campus_label_for_user(userId)
            campus_uc = _norm_campus_name(campus_label)
        if not campus_uc:
            raise HTTPException(status_code=400, detail="Cannot resolve campus; pass campus=MANILA|LAGUNA.")

        camp_doc = await _campus_by_name(campus_uc)
        campus_id_for_filter = (camp_doc or {}).get("campus_id")
        if not campus_id_for_filter:
            raise HTTPException(status_code=400, detail="Unknown campus.")

        # This termId is the PLANNING term P we want to restore
        planning_term = await db[COL_TERMS].find_one(
            {"term_id": termId},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        )
        if not planning_term:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown termId {termId!r} for reactivate operation.",
            )

        curr_tid = await _active_term_id()

        # 1) Archive current active rows (if different term) for this campus
        deactivated_counts = deactivated_stats = 0
        if curr_tid and curr_tid != termId:
            r1 = await db[COL_COUNT].update_many(
                {"term_id": curr_tid, "is_archived": False, "campus_id": campus_id_for_filter},
                {"$set": {"is_archived": True, "updated_at": _now()}},
            )
            r2 = await db[COL_STATS].update_many(
                {"term_id": curr_tid, "is_archived": False, "campus_id": campus_id_for_filter},
                {"$set": {"is_archived": True, "updated_at": _now()}},
            )
            deactivated_counts = r1.modified_count
            deactivated_stats = r2.modified_count

        # 2) Unarchive selected term's rows for this campus
        r3 = await db[COL_COUNT].update_many(
            {"term_id": termId, "is_archived": True, "campus_id": campus_id_for_filter},
            {"$set": {"is_archived": False, "updated_at": _now()}},
        )
        r4 = await db[COL_STATS].update_many(
            {"term_id": termId, "is_archived": True, "campus_id": campus_id_for_filter},
            {"$set": {"is_archived": False, "updated_at": _now()}},
        )

        # 3) Flip is_current back to the term that should *precede* this planning term.
        #    That way, "planning term = next-after-current" becomes this termId again.
        prev_term = await _get_prev_term_doc(planning_term)
        new_current_tid = prev_term.get("term_id", termId)

        await db[COL_TERMS].update_many({}, {"$set": {"is_current": False}})
        await db[COL_TERMS].update_one(
            {"term_id": new_current_tid},
            {"$set": {"is_current": True}},
        )

        return {
            "ok": True,
            "reactivatedTermId": termId,
            "campus": campus_uc,
            "deactivatedCounts": deactivated_counts,
            "deactivatedStats": deactivated_stats,
            "reactivatedCounts": r3.modified_count,
            "reactivatedStats": r4.modified_count,
            "newCurrentTermId": new_current_tid,
            # For the frontend: this is the planning term Pre-Enlistment should show
            "planningTermId": termId,
        }

    # ---- action=import ----
    if not termId:
        # Align with Course Offerings: import pre-enlistment into the *planning* term
        # (TERM0015 if TERM0014 is the current/active term).
        termId = await _planning_term_id()
        if not termId:
            termId = await _active_term_id()
    if not termId:
        raise HTTPException(
            status_code=400,
            detail="No term found; specify termId to import."
        )

    count_rows: List[Dict[str, Any]] = (payload or {}).get("countRows") or []
    stat_rows: List[Dict[str, Any]] = (payload or {}).get("statRows") or []

    # Resolve campus strictly: import is ALWAYS scoped to the caller's campus.
    if not campus_uc:
        campus_label = await _apo_campus_label_for_user(userId)
        campus_uc = _norm_campus_name(campus_label)
    if not campus_uc:
        raise HTTPException(status_code=400, detail="Cannot resolve campus; pass campus=MANILA|LAGUNA.")

    base_campus_doc = await _campus_by_name(campus_uc)
    base_campus_id = (base_campus_doc or {}).get("campus_id")
    if not base_campus_id:
        raise HTTPException(status_code=400, detail="Unknown campus; pass campus=MANILA|LAGUNA.")

    def _row_label(i: int) -> str:
        # CSV row numbers are 1-based with a header line, so first data row is Row 2
        return f"Row {i + 2}"

    def _as_int(v: Any) -> Optional[int]:
        if v is None or v == "":
            return None
        try:
            return int(float(str(v).strip()))
        except Exception:
            return None

    # --------------------------
    # Validate & normalize COUNT
    # --------------------------
    count_errors: List[str] = []
    normalized_count_rows: List[Dict[str, Any]] = []

    if count_rows:
        for i, r in enumerate(count_rows):
            pre_code = (r.get("Code") or r.get("code") or "").strip()
            career_csv = (r.get("Career") or r.get("career") or "").strip()
            acad_group_csv = (r.get("Acad Group") or r.get("acad_group") or "").strip()
            campus_csv_raw = (r.get("Campus") or r.get("campus") or "").strip()
            course_code = (r.get("Course Code") or r.get("course_code") or "").strip().upper()
            count_val = _as_int(r.get("Count", r.get("count")))

            if not pre_code:
                count_errors.append(f"{_row_label(i)}: Missing 'Code'.")
                continue

            if not campus_csv_raw:
                count_errors.append(f"{_row_label(i)}: Missing 'Campus' (must be Manila/Laguna).")
                continue

            campus_from_row = _norm_campus_name(campus_csv_raw)
            if not campus_from_row:
                count_errors.append(f"{_row_label(i)}: Invalid Campus '{campus_csv_raw}'. Use Manila or Laguna.")
                continue

            if campus_from_row != campus_uc:
                count_errors.append(
                    f"{_row_label(i)}: Campus '{campus_csv_raw}' does not match your selected campus ({campus_uc})."
                )
                continue

            if not career_csv:
                count_errors.append(f"{_row_label(i)}: Missing 'Career'.")
                continue

            if not _career_to_program_level(career_csv):
                count_errors.append(f"{_row_label(i)}: Invalid Career '{career_csv}'. Use UGB/UGS or GSM.")
                continue

            if not acad_group_csv:
                count_errors.append(f"{_row_label(i)}: Missing 'Acad Group'.")
                continue

            if not course_code:
                count_errors.append(f"{_row_label(i)}: Missing 'Course Code'.")
                continue

            if count_val is None:
                count_errors.append(f"{_row_label(i)}: Invalid 'Count' value.")
                continue

            course = await _course_by_code(course_code)
            if not course:
                count_errors.append(f"{_row_label(i)}: Unknown Course Code '{course_code}'.")
                continue

            normalized_count_rows.append(
                {
                    "pre_code": pre_code,
                    "career": career_csv,
                    "acad_group": acad_group_csv.strip().upper(),
                    "course": course,
                    "count": count_val,
                }
            )

        if count_errors:
            raise HTTPException(
                status_code=400,
                detail={
                    "message": f"Invalid Pre-enlistment COUNT file for {campus_uc}. Nothing was saved.",
                    "errors": count_errors[:60],
                },
            )

        if not normalized_count_rows:
            raise HTTPException(
                status_code=400,
                detail=f"No valid COUNT rows found. Please check the CSV format and values.",
            )

    # --------------------------
    # Validate & normalize STATS
    # --------------------------
    stat_errors: List[str] = []
    normalized_stat_rows: List[Dict[str, Any]] = []

    if stat_rows:
        for i, r in enumerate(stat_rows):
            program_code = (r.get("Program") or r.get("program") or "").strip()
            if not program_code:
                stat_errors.append(f"{_row_label(i)}: Missing 'Program'.")
                continue

            pinfo = await _program_by_code(program_code)
            if not pinfo:
                stat_errors.append(f"{_row_label(i)}: Unknown Program '{program_code}'.")
                continue

            # Campus validation for STATISTICS should not rely solely on programs.campus_id
            # because some programs can appear in multiple campuses (e.g., 2 years Manila + 2 years Laguna).
            # We primarily validate campus membership via the curriculum table's campus_id.
            prog_id = pinfo.get("program_id")
            has_curriculum_for_campus = False
            if prog_id:
                cur = await db[COL_CURRICULUM].find_one(
                    {"program_id": prog_id, "campus_id": base_campus_id},
                    {"_id": 0, "curriculum_id": 1},
                )
                has_curriculum_for_campus = bool(cur)

            # Fallback: if curriculum is missing for this program, allow only when programs.campus_id matches.
            if not has_curriculum_for_campus:
                prog_campus_id = pinfo.get("campus_id")
                if prog_campus_id and prog_campus_id != base_campus_id:
                    stat_errors.append(
                        f"{_row_label(i)}: Program '{program_code}' isn't offered in {campus_uc} (no curriculum match for this campus)."
                    )
                    continue

            freshman = _as_int(r.get("FRESHMAN"))
            sophomore = _as_int(r.get("SOPHOMORE"))
            junior = _as_int(r.get("JUNIOR"))
            senior = _as_int(r.get("SENIOR"))
            enrollment = _as_int(r.get("ENROLLMENT"))

            if freshman is None or sophomore is None or junior is None or senior is None:
                stat_errors.append(
                    f"{_row_label(i)}: Year-level counts must be numbers (FRESHMAN/SOPHOMORE/JUNIOR/SENIOR)."
                )
                continue

            if enrollment is None:
                enrollment = freshman + sophomore + junior + senior

            normalized_stat_rows.append(
                {
                    "program_id": pinfo.get("program_id"),
                    "freshman": freshman,
                    "sophomore": sophomore,
                    "junior": junior,
                    "senior": senior,
                    "enrollment": enrollment,
                }
            )

        if stat_errors:
            raise HTTPException(
                status_code=400,
                detail={
                    "message": f"Invalid Pre-enlistment STATISTICS file for {campus_uc}. Nothing was saved.",
                    "errors": stat_errors[:60],
                },
            )

        if not normalized_stat_rows:
            raise HTTPException(
                status_code=400,
                detail="No valid STATISTICS rows found. Please check the CSV format and values.",
            )

    # --------------------------
    # Apply replace + insert (safe: campus-scoped only)
    # --------------------------
    if replaceCount:
        await db[COL_COUNT].delete_many({"term_id": termId, "is_archived": False, "campus_id": base_campus_id})
    if replaceStats:
        await db[COL_STATS].delete_many({"term_id": termId, "is_archived": False, "campus_id": base_campus_id})

    now = _now()

    count_docs: List[Dict[str, Any]] = []
    for r in normalized_count_rows:
        course = r["course"]
        # prefer course's college_id; allow Acad Group fallback
        college_id = course.get("college_id")
        if not college_id and r.get("acad_group"):
            college_doc = await _college_by_code(r.get("acad_group"))
            college_id = (college_doc or {}).get("college_id")

        count_docs.append(
            {
                "count_id": await _next_id("PRCNT", COL_COUNT),
                "term_id": termId,
                "college_id": college_id,
                "campus_id": base_campus_id,
                "course_id": course["course_id"],
                "preenlistment_code": r.get("pre_code") or "",
                "career": r["career"],  # keep CSV code for display
                "program_level": _career_to_program_level(r["career"]),
                "acad_group_code": r.get("acad_group") or None,
                "preenlistment_count": int(r["count"]),
                "is_archived": False,
                "created_at": now,
                "updated_at": now,
            }
        )

    stat_docs: List[Dict[str, Any]] = []
    now2 = _now()
    for r in normalized_stat_rows:
        stat_docs.append(
            {
                "stat_id": await _next_id("PRSTAT", COL_STATS),
                "term_id": termId,
                "program_id": r.get("program_id"),
                "campus_id": base_campus_id,
                "enrollment": int(r.get("enrollment") or 0),
                "freshman": int(r.get("freshman") or 0),
                "sophomore": int(r.get("sophomore") or 0),
                "junior": int(r.get("junior") or 0),
                "senior": int(r.get("senior") or 0),
                "is_archived": False,
                "created_at": now2,
                "updated_at": now2,
            }
        )

    if count_docs:
        await db[COL_COUNT].insert_many(count_docs)
    if stat_docs:
        await db[COL_STATS].insert_many(stat_docs)

    return {
        "ok": True,
        "campus": campus_uc,
        "termId": termId,
        "insertedCount": len(count_docs),
        "insertedStats": len(stat_docs),
    }
