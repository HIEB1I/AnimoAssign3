# backend/app/APO/APO_PreEnlistment.py
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple, Literal

from fastapi import APIRouter, HTTPException, Query, Body
from pymongo import ReturnDocument

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

# Archival flags
ACTIVE_Q = {"$ne": True}  # is_archived != True (missing or False)
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
    """
    Atomic counter per collection key -> e.g. PRCNT0001, PRSTAT0001, ...
    """
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
    tn = cur.get("term_number") or 0

    # next term in same AY
    nxt = await db[COL_TERMS].find_one(
        {"acad_year_start": ay, "term_number": tn + 1},
        {"_id": 0, "term_id": 1},
    )
    if nxt:
        return nxt["term_id"]

    # first term of next AY
    nxt2 = await db[COL_TERMS].find_one(
        {"acad_year_start": (ay or 0) + 1, "term_number": 1},
        {"_id": 0, "term_id": 1},
    )
    return nxt2["term_id"] if nxt2 else None


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


async def _program_by_code(program_code: str) -> Optional[Dict[str, Any]]:
    code = (program_code or "").strip().upper()
    if not code:
        return None
    return await db[COL_PROGRAMS].find_one(
        {"program_code": {"$regex": f"^{code}$", "$options": "i"}},
        {"_id": 0, "program_id": 1, "program_code": 1, "campus_id": 1},
    )


async def _apo_campus_label_for_user(user_id: str) -> Optional[str]:
    """
    Fallback campus resolver via role_assignments.scope (type == 'campus').
    Returns "Manila" / "Laguna" / None.
    """
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
    Fetch COUNT + STAT rows.
    COUNT: stored with IDs-only; we $lookup joins to provide display fields, including acad_group = colleges.college_code.
    STATS: stored with IDs-only; we $lookup joins to provide program_code and term display, and always scoped by campus_id.
    """
    campus_uc = _norm_campus_name(campus)
    campus_label = "Manila" if campus_uc == "MANILA" else ("Laguna" if campus_uc == "LAGUNA" else None)
    if not campus_label:
        campus_label = await _apo_campus_label_for_user(userId)
        campus_uc = _norm_campus_name(campus_label)

    # Resolve campus_id for filtering
    campus_id_for_filter: Optional[str] = None
    if campus_uc:
        camp = await _campus_by_name(campus_uc)
        campus_id_for_filter = (camp or {}).get("campus_id")

    # Determine term
    if scope == "active" and not termId:
        termId = await _active_term_id()
        if not termId:
            return {"count": [], "statistics": [], "meta": {"term_id": "", "ay_label": "AY —", "campus_label": campus_label}}

    if scope in ("active", "archive"):
        arch_val = (scope == "archive")
        if scope == "archive" and not termId:
            raise HTTPException(status_code=400, detail="termId is required for archive scope.")

        # ---------------- COUNT (IDs stored; join for display) ----------------
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
                    "course_code_display": {
                        "$cond": [
                            {"$isArray": "$course.course_code"},
                            {"$ifNull": [{"$arrayElemAt": ["$course.course_code", 0]}, ""]},
                            {"$ifNull": ["$course.course_code", ""]},
                        ]
                    },
                    # acad_group should reflect colleges.college_code for display
                    "acad_group_display": "$college.college_code",
                }
            },
            {
                "$project": {
                    "_id": 0,
                    # Stored (IDs + business fields)
                    "count_id": 1,
                    "term_id": 1,
                    "college_id": 1,
                    "campus_id": 1,
                    "course_id": 1,
                    "preenlistment_code": 1,
                    "career": 1,
                    "preenlistment_count": 1,
                    "is_archived": 1,
                    "created_at": 1,
                    "updated_at": 1,

                    # Display-only (joined)
                    "terms.term_number": "$term.term_number",
                    "terms.acad_year_start": "$term.acad_year_start",
                    "colleges.college_code": "$college.college_code",
                    "campuses.campus_name": "$campus.campus_name",
                    "courses.course_code": "$course_code_display",
                    "acad_group": "$acad_group_display",  # <-- for UI column
                }
            },
            {"$sort": {"updated_at": -1, "created_at": -1}},
        ]
        count_rows = [r async for r in db[COL_COUNT].aggregate(count_pipeline)]

        def to_count_view(r: Dict[str, Any]) -> Dict[str, Any]:
            return {
                # IDs
                "count_id": r.get("count_id", ""),
                "term_id": r.get("term_id", ""),
                "college_id": r.get("college_id"),
                "campus_id": r.get("campus_id"),
                "course_id": r.get("course_id"),
                # business (FE expects `count`, so alias preenlistment_count)
                "preenlistment_code": r.get("preenlistment_code", ""),
                "career": r.get("career", ""),
                "count": r.get("preenlistment_count", 0),
                "is_archived": r.get("is_archived", False),
                "created_at": r.get("created_at"),
                "updated_at": r.get("updated_at"),
                # display fields
                "term_number": (r.get("terms") or {}).get("term_number"),
                "acad_year_start": (r.get("terms") or {}).get("acad_year_start"),
                "college_code": (r.get("colleges") or {}).get("college_code"),
                "campus_name": (r.get("campuses") or {}).get("campus_name"),
                "course_code": (r.get("courses") or {}).get("course_code", ""),
                "acad_group": r.get("acad_group") or "",  # <- now shows colleges.college_code
            }

        # ---------------- STATS (IDs stored; join for display; campus-scoped) ----------------
        # Always scope by campus_id if available so APO Manila/Laguna do not see each other.
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
                    # Stored
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
                    # Display-only
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
        # Build a list of archived terms (optionally campus-scoped)
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
    action: Literal["import", "archive"] = Query("import"),
    replaceCount: bool = Query(False),
    replaceStats: bool = Query(False),
    campus: Optional[str] = Query(None, description="Campus name, e.g., MANILA or LAGUNA"),
    payload: Dict[str, Any] = Body({}, description="For action=import: {countRows, statRows}"),
):
    """
    Import/Archive with campus awareness.
    COUNT: store **IDs only** (+ minimal business fields).
    STATS: store **IDs only** (+ enrollment & year levels). Campus is REQUIRED for isolation.
    """
    campus_uc = _norm_campus_name(campus)

    if action == "archive":
        if not termId:
            termId = await _active_term_id()
        if not termId:
            raise HTTPException(status_code=400, detail="No active term to archive.")

        # Optional campus scoping for archive
        campus_id_for_filter = None
        if campus_uc:
            camp_doc = await _campus_by_name(campus_uc)
            campus_id_for_filter = (camp_doc or {}).get("campus_id")

        count_q = {"term_id": termId, "is_archived": ACTIVE_Q}
        stats_q = {"term_id": termId, "is_archived": ACTIVE_Q}
        if campus_id_for_filter:
            count_q["campus_id"] = campus_id_for_filter
            stats_q["campus_id"] = campus_id_for_filter

        upd1 = await db[COL_COUNT].update_many(count_q, {"$set": {"is_archived": True, "updated_at": _now()}})
        upd2 = await db[COL_STATS].update_many(stats_q, {"$set": {"is_archived": True, "updated_at": _now()}})

        # Advance current term pointer globally (simple design)
        next_tid = await _next_term_id(termId)
        if next_tid:
            await db[COL_TERMS].update_many({}, {"$set": {"is_current": False}})
            await db[COL_TERMS].update_one({"term_id": next_tid}, {"$set": {"is_current": True}})

        return {"ok": True, "archivedCounts": upd1.modified_count, "archivedStats": upd2.modified_count, "newActiveTermId": next_tid}

    # ---- action=import ----
    if not termId:
        termId = await _active_term_id()
    if not termId:
        raise HTTPException(status_code=400, detail="No active term; specify termId to import.")

    count_rows: List[Dict[str, Any]] = (payload or {}).get("countRows") or []
    stat_rows: List[Dict[str, Any]] = (payload or {}).get("statRows") or []

    # Campus is critical for STAT isolation (APO Manila vs Laguna).
    campus_doc = await _campus_by_name(campus_uc) if campus_uc else None
    campus_id_for_filter = (campus_doc or {}).get("campus_id")

    # Replace COUNT rows (term + campus scoped if campus provided)
    if replaceCount:
        del_q = {"term_id": termId, "is_archived": False}
        if campus_id_for_filter:
            del_q["campus_id"] = campus_id_for_filter
        await db[COL_COUNT].delete_many(del_q)

    # Replace STATS rows (term + campus scoped only — ensures isolation)
    if replaceStats:
        del_qs: Dict[str, Any] = {"term_id": termId, "is_archived": False}
        if campus_id_for_filter:
            del_qs["campus_id"] = campus_id_for_filter
        await db[COL_STATS].delete_many(del_qs)

    # ---- Insert COUNT rows (IDs ONLY + business fields) ----
    now = _now()
    count_docs: List[Dict[str, Any]] = []
    for r in count_rows:
        pre_code = (r.get("Code") or r.get("code") or "").strip()
        career = (r.get("Career") or r.get("career") or "").strip()
        campus_name = _norm_campus_name(r.get("Campus") or r.get("campus"))
        course_code = (r.get("Course Code") or r.get("course_code") or "").strip().upper()

        if not (career and campus_name and course_code):
            continue

        try:
            cnt_val = int(r.get("Count", r.get("count", 0)) or 0)
        except Exception:
            cnt_val = 0

        course = await _course_by_code(course_code)
        if not course:
            # Skip unknown course rows
            continue

        college_id = course.get("college_id")
        campus_doc_row = await _campus_by_name(campus_name)
        campus_id = (campus_doc_row or {}).get("campus_id")

        doc = {
            "count_id": await _next_id("PRCNT", COL_COUNT),
            "term_id": termId,
            "college_id": college_id,
            "campus_id": campus_id,
            "course_id": course["course_id"],
            "preenlistment_code": pre_code,
            "career": r.get("Career") or r.get("career") or "",
            "preenlistment_count": cnt_val,
            "is_archived": False,
            "created_at": now,
            "updated_at": now,
        }
        count_docs.append(doc)

    if count_docs:
        await db[COL_COUNT].insert_many(count_docs)

    # ---- Insert STATS rows (IDs ONLY; always campus-scoped) ----
    # Expected CSV fields: Program (program_code), FRESHMAN, SOPHOMORE, JUNIOR, SENIOR, optional ENROLLMENT
    now2 = _now()
    stat_docs: List[Dict[str, Any]] = []

    def _to_int(x: Any) -> int:
        try:
            return int(x or 0)
        except Exception:
            return 0

    for r in stat_rows:
        program_code = (r.get("Program") or r.get("program") or "").strip().upper()
        if not program_code:
            continue

        pinfo = await _program_by_code(program_code)
        if not pinfo:
            # Skip unknown program rows
            continue

        freshman = _to_int(r.get("FRESHMAN"))
        sophomore = _to_int(r.get("SOPHOMORE"))
        junior = _to_int(r.get("JUNIOR"))
        senior = _to_int(r.get("SENIOR"))
        # If ENROLLMENT not provided, compute as sum of levels
        enrollment = _to_int(r.get("ENROLLMENT")) or (freshman + sophomore + junior + senior)

        # Determine campus_id for this stat row:
        # Priority: explicit campus parameter -> campus_id_for_filter
        # If not provided, you may derive from program (but for isolation, we strongly prefer explicit campus)
        campus_id_for_stat = campus_id_for_filter or pinfo.get("campus_id")
        if not campus_id_for_stat:
            # If we cannot resolve campus, skip to avoid cross-campus leakage.
            continue

        stat_doc: Dict[str, Any] = {
            "stat_id": await _next_id("PRSTAT", COL_STATS),
            "term_id": termId,
            "program_id": pinfo.get("program_id"),
            "campus_id": campus_id_for_stat,
            "enrollment": enrollment,
            "freshman": freshman,
            "sophomore": sophomore,
            "junior": junior,
            "senior": senior,
            "is_archived": False,
            "created_at": now2,
            "updated_at": now2,
        }
        stat_docs.append(stat_doc)

    if stat_docs:
        await db[COL_STATS].insert_many(stat_docs)

    return {"insertedCount": len(count_docs), "insertedStats": len(stat_docs)}
