# backend/app/APO/APO_PreEnlistment.py
from datetime import datetime
from typing import Any, Dict, List, Optional, Literal

from fastapi import APIRouter, HTTPException, Query, Body
from ..main import db  # Motor client/db

router = APIRouter(prefix="/apo", tags=["apo"])

COL_COUNT = "preenlistment_count"
COL_STATS = "preenlistment_statistics"
COL_TERMS = "terms"
COL_COURSES = "courses"
COL_PROGRAMS = "programs"
COL_ROLE_ASSIGNMENTS = "role_assignments"
COL_CAMPUSES = "campuses"


def _now() -> datetime:
    return datetime.utcnow()


def _new_id(prefix: str) -> str:
    # millisecond-ish generator, consistent with seeds
    return f"{prefix}{int(datetime.utcnow().timestamp() * 1000)}"


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
        "ay_label": _ay_label(t.get("acad_year_start")),
        "term_number": t.get("term_number"),
        "is_current": t.get("is_current", False),
    }


async def _active_term_id() -> Optional[str]:
    t = await db[COL_TERMS].find_one({"is_current": True}, {"_id": 0, "term_id": 1})
    return t["term_id"] if t else None


async def _next_term_id(current_tid: str) -> Optional[str]:
    """
    Find the next term based on (acad_year_start, term_number).
    If none exists, return None (no rollover).
    """
    cur = await db[COL_TERMS].find_one(
        {"term_id": current_tid},
        {"_id": 0, "acad_year_start": 1, "term_number": 1},
    )
    if not cur:
        return None

    ay = cur.get("acad_year_start")
    tn = cur.get("term_number")

    # first try next term_number in the same AY
    nxt = await db[COL_TERMS].find_one(
        {"acad_year_start": ay, "term_number": tn + 1},
        {"_id": 0, "term_id": 1},
    )
    if nxt:
        return nxt["term_id"]

    # else first term of the next AY
    nxt2 = await db[COL_TERMS].find_one(
        {"acad_year_start": ay + 1, "term_number": 1},
        {"_id": 0, "term_id": 1},
    )
    return nxt2["term_id"] if nxt2 else None


async def _apo_campus_label_for_user(user_id: str) -> Optional[str]:
    """
    Find campus via role_assignments.scope where type == 'campus',
    then map to campuses.campus_name ("Manila" / "Laguna").
    """
    ra = await db[COL_ROLE_ASSIGNMENTS].find_one(
        {"user_id": user_id},
        {"_id": 0, "scope": 1},
    )
    if not ra:
        return None

    scope = ra.get("scope") or []
    if isinstance(scope, dict):
        scope = [scope]

    campus_id = None
    for s in scope:
        if isinstance(s, dict) and s.get("type") in ("campus", "Campus"):
            campus_id = s.get("id")
            break

    if not campus_id:
        return None

    camp = await db[COL_CAMPUSES].find_one(
        {"campus_id": campus_id},
        {"_id": 0, "campus_name": 1},
    )
    name = (camp or {}).get("campus_name")
    if not name:
        return None
    n = str(name).strip().upper()
    if n == "MANILA":
        return "Manila"
    if n == "LAGUNA":
        return "Laguna"
    return name


def _campus_name_to_id(campus_name: str) -> Optional[str]:
    s = (campus_name or "").strip().upper()
    if s == "MANILA":
        return "CMPS001"
    if s == "LAGUNA":
        return "CMPS002"
    return None


async def _course_id_by_code(course_code: str) -> Optional[str]:
    code = (course_code or "").strip().upper()
    if not code:
        return None
    doc = await db[COL_COURSES].find_one(
        {"course_code": {"$elemMatch": {"$regex": f"^{code}$", "$options": "i"}}},
        {"_id": 0, "course_id": 1},
    )
    return doc["course_id"] if doc else None


async def _program_id_by_code(program_code: str) -> Optional[str]:
    code = (program_code or "").strip().upper()
    if not code:
        return None
    doc = await db[COL_PROGRAMS].find_one(
        {"program_code": {"$regex": f"^{code}$", "$options": "i"}},
        {"_id": 0, "program_id": 1},
    )
    return doc["program_id"] if doc else None


ACTIVE_Q = {"$ne": True}  # not archived (missing/false)
ARCH_Q = True


@router.get("/preenlistment")
async def preenlistment_get(
    userId: str = Query(..., min_length=3),
    termId: Optional[str] = Query(None),
    scope: Literal["active", "archive", "archivesMeta"] = Query("active"),
):
    campus_label = await _apo_campus_label_for_user(userId)

    if scope == "active" and not termId:
        termId = await _active_term_id()
        if not termId:
            return {
                "count": [],
                "statistics": [],
                "meta": {"term_id": "", "ay_label": "AY —", "campus_label": campus_label},
            }

    if scope == "active":
        count_cur = db[COL_COUNT].find(
            {"user_id": userId, "term_id": termId, "is_archived": ACTIVE_Q},
            {"_id": 0},
        )
        stats_cur = db[COL_STATS].find(
            {"term_id": termId, "is_archived": ACTIVE_Q},
            {"_id": 0},
        )
        count = [doc async for doc in count_cur]
        statistics = [doc async for doc in stats_cur]
        meta = await _term_meta(termId)
        meta["campus_label"] = campus_label
        return {"count": count, "statistics": statistics, "meta": meta}

    if scope == "archive":
        if not termId:
            raise HTTPException(status_code=400, detail="termId is required for archive scope.")
        count_cur = db[COL_COUNT].find(
            {"user_id": userId, "term_id": termId, "is_archived": ARCH_Q},
            {"_id": 0},
        )
        stats_cur = db[COL_STATS].find(
            {"term_id": termId, "is_archived": ARCH_Q},
            {"_id": 0},
        )
        count = [doc async for doc in count_cur]
        statistics = [doc async for doc in stats_cur]
        if not count and not statistics:
            raise HTTPException(status_code=404, detail="Archive not found for this term/user.")
        meta = await _term_meta(termId)
        meta["campus_label"] = campus_label
        return {"count": count, "statistics": statistics, "archiveMeta": meta}

    if scope == "archivesMeta":
        user_terms = await db[COL_COUNT].distinct("term_id", {"user_id": userId, "is_archived": ARCH_Q})
        stat_terms = await db[COL_STATS].distinct("term_id", {"is_archived": ARCH_Q})
        tids = sorted(set(user_terms) | set(stat_terms))
        items: List[Dict[str, Any]] = []
        for tid in tids:
            meta = await _term_meta(tid)
            items.append({
                "term_id": tid,
                "ay_label": meta.get("ay_label", "AY —"),
                "courses": await db[COL_COUNT].count_documents({"user_id": userId, "term_id": tid, "is_archived": ARCH_Q}),
                "programs": await db[COL_STATS].count_documents({"term_id": tid, "is_archived": ARCH_Q}),
            })
        # newest first by acad_year_start/term_number is not guaranteed; term_id string sort is OK for now
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
    payload: Dict[str, Any] = Body({}, description="For action=import: {countRows, statRows}"),
):
    if not termId:
        termId = await _active_term_id()

    if action == "archive":
        if not termId:
            raise HTTPException(status_code=400, detail="No active term to archive.")

        upd1 = await db[COL_COUNT].update_many(
            {"user_id": userId, "term_id": termId, "is_archived": ACTIVE_Q},
            {"$set": {"is_archived": True, "updated_at": _now()}},
        )
        upd2 = await db[COL_STATS].update_many(
            {"term_id": termId, "is_archived": ACTIVE_Q},
            {"$set": {"is_archived": True, "updated_at": _now()}},
        )

        # advance is_current pointer
        next_tid = await _next_term_id(termId)
        if next_tid:
            await db[COL_TERMS].update_many({}, {"$set": {"is_current": False}})
            await db[COL_TERMS].update_one({"term_id": next_tid}, {"$set": {"is_current": True}})

        return {
            "ok": True,
            "archivedCounts": upd1.modified_count,
            "archivedStats": upd2.modified_count,
            "newActiveTermId": next_tid,
        }

    # ---- action=import ----
    if not termId:
        raise HTTPException(status_code=400, detail="No active term; specify termId to import.")

    count_rows: List[Dict[str, Any]] = (payload or {}).get("countRows") or []
    stat_rows: List[Dict[str, Any]] = (payload or {}).get("statRows") or []

    if replaceCount:
        await db[COL_COUNT].delete_many({"user_id": userId, "term_id": termId, "is_archived": ACTIVE_Q})
    if replaceStats:
        await db[COL_STATS].delete_many({"term_id": termId, "is_archived": ACTIVE_Q})

    now = _now()
    count_docs: List[Dict[str, Any]] = []
    for r in count_rows:
        pre_code = (r.get("Code") or r.get("code") or "").strip()
        career = (r.get("Career") or r.get("career") or "").strip()
        acad_group = (r.get("Acad Group") or r.get("AcadGroup") or r.get("acad_group") or "").strip()
        campus_name = (r.get("Campus") or r.get("campus") or "").strip().upper()
        course_code = (r.get("Course Code") or r.get("course_code") or "").strip().upper()
        if not (career and acad_group and campus_name and course_code):
            continue
        try:
            cnt_val = int(r.get("Count", r.get("count", 0)) or 0)
        except Exception:
            cnt_val = 0

        campus_id = _campus_name_to_id(campus_name)
        course_id = await _course_id_by_code(course_code)

        doc: Dict[str, Any] = {
            "count_id": _new_id("PRCNT"),
            "user_id": userId,
            "term_id": termId,
            "preenlistment_code": pre_code,
            "career": career,
            "acad_group": acad_group,
            "campus_name": campus_name,
            "course_code": course_code,
            "count": cnt_val,
            "is_archived": False,
            "created_at": now,
            "updated_at": now,
        }
        if campus_id:
            doc["campus_id"] = campus_id
        if course_id:
            doc["course_id"] = course_id

        count_docs.append(doc)

    if count_docs:
        await db[COL_COUNT].insert_many(count_docs)

    now2 = _now()
    stat_docs: List[Dict[str, Any]] = []
    for r in stat_rows:
        program_code = (r.get("Program") or r.get("program") or "").strip().upper()
        if not program_code:
            continue

        def _i(x: Any) -> int:
            try:
                return int(x or 0)
            except Exception:
                return 0

        program_id = await _program_id_by_code(program_code)
        sdoc: Dict[str, Any] = {
            "stat_id": _new_id("PRSTAT"),
            "term_id": termId,
            "program_code": program_code,
            "freshman": _i(r.get("FRESHMAN")),
            "sophomore": _i(r.get("SOPHOMORE")),
            "junior": _i(r.get("JUNIOR")),
            "senior": _i(r.get("SENIOR")),
            "is_archived": False,
            "created_at": now2,
            "updated_at": now2,
        }
        if program_id:
            sdoc["program_id"] = program_id
        stat_docs.append(sdoc)

    if stat_docs:
        await db[COL_STATS].insert_many(stat_docs)

    return {"insertedCount": len(count_docs), "insertedStats": len(stat_docs)}
