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
    import re
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
    c = (career or "").strip().upper()
    if c == "UGB":
        return "Undergraduate"
    if c == "GSM":
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
        termId = await _active_term_id()
        if not termId:
            return {"count": [], "statistics": [], "meta": {"term_id": "", "ay_label": "AY —", "campus_label": campus_label}}

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
    action: Literal["import", "archive"] = Query("import"),
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

    if action == "archive":
        if not termId:
            termId = await _active_term_id()
        if not termId:
            raise HTTPException(status_code=400, detail="No active term to archive.")

        if not campus_uc:
            campus_label = await _apo_campus_label_for_user(userId)
            campus_uc = _norm_campus_name(campus_label)

        campus_id_for_filter = None
        if campus_uc:
            camp_doc = await _campus_by_name(campus_uc)
            campus_id_for_filter = (camp_doc or {}).get("campus_id")

        if not campus_id_for_filter:
            raise HTTPException(status_code=400, detail="Cannot resolve campus; pass campus=MANILA|LAGUNA.")

        count_q = {"term_id": termId, "is_archived": False, "campus_id": campus_id_for_filter}
        stats_q = {"term_id": termId, "is_archived": False, "campus_id": campus_id_for_filter}

        upd1 = await db[COL_COUNT].update_many(count_q, {"$set": {"is_archived": True, "updated_at": _now()}})
        upd2 = await db[COL_STATS].update_many(stats_q, {"$set": {"is_archived": True, "updated_at": _now()}})

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

    if not campus_uc:
        campus_label = await _apo_campus_label_for_user(userId)
        campus_uc = _norm_campus_name(campus_label)

    base_campus_doc = await _campus_by_name(campus_uc) if campus_uc else None
    base_campus_id = (base_campus_doc or {}).get("campus_id")

    # scoped delete
    if replaceCount:
        target_campuses: List[str] = []
        if base_campus_id:
            target_campuses = [base_campus_id]
        else:
            seen = set()
            for r in count_rows:
                cname = _norm_campus_name(r.get("Campus") or r.get("campus"))
                if not cname:
                    continue
                cdoc = await _campus_by_name(cname)
                cid = (cdoc or {}).get("campus_id")
                if cid and cid not in seen:
                    seen.add(cid)
                    target_campuses.append(cid)
        if not target_campuses:
            raise HTTPException(status_code=400, detail="Cannot resolve campus for COUNT replace; pass campus=MANILA|LAGUNA or include 'Campus' per row.")
        for cid in target_campuses:
            await db[COL_COUNT].delete_many({"term_id": termId, "is_archived": False, "campus_id": cid})

    if replaceStats:
        target_campuses: List[str] = []
        if base_campus_id:
            target_campuses = [base_campus_id]
        else:
            seen = set()
            for r in stat_rows:
                pcode = (r.get("Program") or "").strip()
                if not pcode:
                    continue
                pinfo = await _program_by_code(pcode)
                cid = (pinfo or {}).get("campus_id")
                if cid and cid not in seen:
                    seen.add(cid)
                    target_campuses.append(cid)
        if not target_campuses:
            raise HTTPException(status_code=400, detail="Cannot resolve campus for STATS replace; pass campus=MANILA|LAGUNA.")
        for cid in target_campuses:
            await db[COL_STATS].delete_many({"term_id": termId, "is_archived": False, "campus_id": cid})

    # ---- INSERT COUNT ----
    now = _now()
    count_docs: List[Dict[str, Any]] = []

    def _to_int(x: Any) -> int:
        try:
            return int(x or 0)
        except Exception:
            return 0

    for r in count_rows:
        pre_code = (r.get("Code") or r.get("code") or "").strip()
        career_csv = (r.get("Career") or r.get("career") or "").strip()
        campus_name = _norm_campus_name(r.get("Campus") or r.get("campus")) or campus_uc
        acad_group_csv = (r.get("Acad Group") or r.get("acad_group") or "").strip().upper()  # display only
        course_code = (r.get("Course Code") or r.get("course_code") or "").strip().upper()
        if not (career_csv and campus_name and course_code):
            continue

        course = await _course_by_code(course_code)
        if not course:
            continue

        college_id = course.get("college_id")
        if not college_id and acad_group_csv:
            college_doc = await _college_by_code(acad_group_csv)
            college_id = (college_doc or {}).get("college_id")
            
        campus_doc_row = await _campus_by_name(campus_name)
        campus_id = (campus_doc_row or {}).get("campus_id")
        if not campus_id:
            continue

        doc = {
            "count_id": await _next_id("PRCNT", COL_COUNT),
            "term_id": termId,
            "college_id": college_id,
            "campus_id": campus_id,
            "course_id": course["course_id"],
            "preenlistment_code": pre_code,
            # keep CSV code for display
            "career": career_csv,
            # store program_level for reference (not displayed)
            "program_level": _career_to_program_level(career_csv),
            # keep CSV acad group code for display (fallback in GET via lookup when missing)
            "acad_group_code": acad_group_csv or None,
            "preenlistment_count": _to_int(r.get("Count", r.get("count", 0))),
            "is_archived": False,
            "created_at": now,
            "updated_at": now,
        }
        count_docs.append(doc)

    if count_docs:
        await db[COL_COUNT].insert_many(count_docs)

    # ---- INSERT STATS ----
    now2 = _now()
    stat_docs: List[Dict[str, Any]] = []

    for r in stat_rows:
        program_code = (r.get("Program") or r.get("program") or "").strip()
        if not program_code:
            continue
        pinfo = await _program_by_code(program_code)
        if not pinfo:
            # skip unknown program code like BSCS (CBL) only if really not found
            continue

        freshman = _to_int(r.get("FRESHMAN"))
        sophomore = _to_int(r.get("SOPHOMORE"))
        junior = _to_int(r.get("JUNIOR"))
        senior = _to_int(r.get("SENIOR"))
        enrollment = _to_int(r.get("ENROLLMENT")) or (freshman + sophomore + junior + senior)

        campus_name = _norm_campus_name(campus_uc)
        campus_id_for_stat = None
        if campus_name:
            cdoc = await _campus_by_name(campus_name)
            campus_id_for_stat = (cdoc or {}).get("campus_id")
        if not campus_id_for_stat:
            campus_id_for_stat = pinfo.get("campus_id")
        if not campus_id_for_stat:
            continue

        stat_docs.append({
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
        })

    if stat_docs:
        await db[COL_STATS].insert_many(stat_docs)

    return {"insertedCount": len(count_docs), "insertedStats": len(stat_docs)}
