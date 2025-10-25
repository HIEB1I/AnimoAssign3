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

def _now() -> datetime:
    return datetime.utcnow()

def _new_id(prefix: str) -> str:
    # millisecond-ish unique generator, consistent with seeds
    return f"{prefix}{int(datetime.utcnow().timestamp() * 1000)}"

def _ay_label(ay_start: Optional[str]) -> str:
    # terms.acad_year_start is a string in the seed; format AY YYYY-(YYYY+1)
    if not ay_start:
        return "AY —"
    try:
        y = int(str(ay_start).strip())
        return f"AY {y}-{y+1}"
    except Exception:
        return "AY —"

async def _term_meta(term_id: str) -> Dict[str, Any]:
    t = await db[COL_TERMS].find_one(
        {"term_id": term_id},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1, "term_index": 1, "status": 1},
    )
    if not t:
        return {"term_id": term_id, "ay_label": "AY —"}
    return {
        "term_id": t["term_id"],
        "ay_label": _ay_label(t.get("acad_year_start")),
        "term_number": t.get("term_number"),
        "term_index": t.get("term_index"),
        "status": t.get("status"),
    }

async def _active_term_id() -> Optional[str]:
    t = await db[COL_TERMS].find_one({"status": "active"}, {"_id": 0, "term_id": 1})
    return t["term_id"] if t else None

async def _next_term_id(current_tid: str) -> Optional[str]:
    cur = await db[COL_TERMS].find_one({"term_id": current_tid}, {"_id": 0, "term_index": 1})
    if not cur:
        return None
    nxt = await db[COL_TERMS].find_one({"term_index": cur["term_index"] + 1}, {"_id": 0, "term_id": 1})
    return nxt["term_id"] if nxt else None

# Map campus_name used in preenlistment_count to campus_id codes in the seed.
# Seed has campus_id "CMPS001" (Manila Campus) and "CMPS002" (Laguna Campus).
def _campus_name_to_id(campus_name: str) -> Optional[str]:
    s = (campus_name or "").strip().upper()
    if s == "MANILA":
        return "CMPS001"
    if s == "LAGUNA":
        return "CMPS002"
    return None

async def _course_id_by_code(course_code: str) -> Optional[str]:
    """Find course_id by matching a code inside courses.course_code (array)."""
    code = (course_code or "").strip().upper()
    if not code:
        return None
    # Match either exact element or case-insensitive element in array
    # $in with exact uppercase is fine given seed examples; use $elemMatch for safety
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

ACTIVE_Q = {"$ne": True}  # not archived (missing or False)
ARCH_Q = True             # archived

# -------------------- GET --------------------

@router.get("/preenlistment")
async def preenlistment_get(
    userId: str = Query(..., min_length=3),
    termId: Optional[str] = Query(None),
    scope: Literal["active", "archive", "archivesMeta"] = Query("active"),
):
    """
    scope=active        -> active rows for user+term (is_archived != true)
    scope=archive       -> archived rows for user+term (is_archived == true)
    scope=archivesMeta  -> list of term snapshots that have archived rows (with AY label)
    If termId isn't provided for 'active', the current active term is used.
    For 'archive', termId is required.
    """
    # resolve term
    if scope == "active" and not termId:
        termId = await _active_term_id()
        if not termId:
            return {"count": [], "statistics": [], "meta": {"term_id": "", "ay_label": "AY —"}}

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
        return {"count": count, "statistics": statistics, "meta": await _term_meta(termId)}

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
        return {"count": count, "statistics": statistics, "archiveMeta": await _term_meta(termId)}

    if scope == "archivesMeta":
        # All terms that have archived rows (by this user for counts OR globally for stats)
        user_terms = await db[COL_COUNT].distinct("term_id", {"user_id": userId, "is_archived": ARCH_Q})
        stat_terms = await db[COL_STATS].distinct("term_id", {"is_archived": ARCH_Q})
        tids = sorted(set(user_terms) | set(stat_terms))
        items: List[Dict[str, Any]] = []
        for tid in tids:
            meta = await _term_meta(tid)
            courses_total = await db[COL_COUNT].count_documents({"user_id": userId, "term_id": tid, "is_archived": ARCH_Q})
            programs_total = await db[COL_STATS].count_documents({"term_id": tid, "is_archived": ARCH_Q})
            items.append({
                "term_id": tid,
                "ay_label": meta.get("ay_label", "AY —"),
                "courses": courses_total,
                "programs": programs_total,
            })
        # newest-ish first by term_id (TERM_2025_T3 > TERM_2025_T2 ...)
        items.sort(key=lambda x: x["term_id"], reverse=True)
        return {"archives": items}

    raise HTTPException(status_code=400, detail="Invalid scope")

# -------------------- POST --------------------

@router.post("/preenlistment")
async def preenlistment_post(
    userId: str = Query(..., min_length=3),
    termId: Optional[str] = Query(None),
    action: Literal["import", "archive"] = Query("import"),
    replaceCount: bool = Query(False),
    replaceStats: bool = Query(False),
    payload: Dict[str, Any] = Body({}, description="For action=import: {countRows, statRows}"),
):
    """
    action=import
      - Inserts ACTIVE rows (is_archived: false) into:
        - preenlistment_count (maps campus_name -> campus_id; resolves course_id if possible)
        - preenlistment_statistics (resolves program_id if possible)
      - If replaceCount/replaceStats are true, deletes only ACTIVE rows for the given term first.

    action=archive
      - Flips ACTIVE rows for this user+term to ARCHIVED (is_archived: true) in both collections.
      - Advances terms: set all terms to "inactive" then marks the next term (by term_index) as "active".
    """
    # Determine active term when not specified
    if not termId:
        termId = await _active_term_id()

    if action == "archive":
        if not termId:
            raise HTTPException(status_code=400, detail="No active term to archive.")

        # Flip ACTIVE rows to archived
        upd1 = await db[COL_COUNT].update_many(
            {"user_id": userId, "term_id": termId, "is_archived": ACTIVE_Q},
            {"$set": {"is_archived": True, "updated_at": _now()}},
        )
        upd2 = await db[COL_STATS].update_many(
            {"term_id": termId, "is_archived": ACTIVE_Q},
            {"$set": {"is_archived": True, "updated_at": _now()}},
        )

        # Advance the term pointer (activate next by term_index)
        next_tid = await _next_term_id(termId)
        if next_tid:
            # only one active at a time
            await db[COL_TERMS].update_many({}, {"$set": {"status": "inactive"}})
            await db[COL_TERMS].update_one({"term_id": next_tid}, {"$set": {"status": "active"}})

        return {
            "ok": True,
            "archivedCounts": upd1.modified_count,
            "archivedStats": upd2.modified_count,
            "newActiveTermId": next_tid,
        }

    # -------- action=import --------
    if not termId:
        raise HTTPException(status_code=400, detail="No active term; specify termId to import.")

    count_rows: List[Dict[str, Any]] = (payload or {}).get("countRows") or []
    stat_rows: List[Dict[str, Any]] = (payload or {}).get("statRows") or []

    if replaceCount:
        await db[COL_COUNT].delete_many({"user_id": userId, "term_id": termId, "is_archived": ACTIVE_Q})
    if replaceStats:
        await db[COL_STATS].delete_many({"term_id": termId, "is_archived": ACTIVE_Q})

    # ---- transform & insert counts (seed fields) ----
    now = _now()
    count_docs: List[Dict[str, Any]] = []
    for r in count_rows:
        # expected CSV headers (same as earlier UI): Code, Career, Acad Group, Campus, Course Code, Count
        pre_code = (r.get("Code") or r.get("code") or "").strip()                     # -> preenlistment_code
        career = (r.get("Career") or r.get("career") or "").strip()
        acad_group = (r.get("Acad Group") or r.get("AcadGroup") or r.get("acad_group") or "").strip()
        campus_name = (r.get("Campus") or r.get("campus") or "").strip().upper()
        course_code = (r.get("Course Code") or r.get("course_code") or "").strip().upper()

        if not (career and acad_group and campus_name and course_code):
            # skip incomplete row
            continue

        try:
            cnt_val = int(r.get("Count", r.get("count", 0)) or 0)
        except Exception:
            cnt_val = 0

        campus_id = _campus_name_to_id(campus_name)  # seed codes
        course_id = await _course_id_by_code(course_code)  # may be None if not found (kept as None/not set)

        doc: Dict[str, Any] = {
            "count_id": _new_id("PRCNT"),
            "campus_id": campus_id,
            "course_id": course_id,            # can be None if lookup fails; do NOT invent values
            "user_id": userId,
            "term_id": termId,
            "preenlistment_code": pre_code,    # string in seed e.g., "1", "2", ...
            "career": career,
            "acad_group": acad_group,
            "campus_name": campus_name,        # e.g., "MANILA" / "LAGUNA"
            "course_code": course_code,
            "count": cnt_val,
            "is_archived": False,
            "created_at": now,
            "updated_at": now,
        }
        # If course_id lookup failed, omit key instead of fabricating
        if doc["course_id"] is None:
            del doc["course_id"]
        if doc["campus_id"] is None:
            del doc["campus_id"]

        count_docs.append(doc)

    if count_docs:
        await db[COL_COUNT].insert_many(count_docs)

    # ---- transform & insert stats (seed fields) ----
    now2 = _now()
    stat_docs: List[Dict[str, Any]] = []
    for r in stat_rows:
        # expected headers: Program, FRESHMAN, SOPHOMORE, JUNIOR, SENIOR
        program_code = (r.get("Program") or r.get("program") or "").strip().upper()
        if not program_code:
            continue

        def _to_int(x: Any) -> int:
            try:
                return int(x or 0)
            except Exception:
                return 0

        fr = _to_int(r.get("FRESHMAN"))
        so = _to_int(r.get("SOPHOMORE"))
        jr = _to_int(r.get("JUNIOR"))
        sr = _to_int(r.get("SENIOR"))

        program_id = await _program_id_by_code(program_code)  # may be None if seed doesn't have that code

        sdoc: Dict[str, Any] = {
            "stat_id": _new_id("PRSTAT"),
            "program_id": program_id,          # remove if None
            "term_id": termId,
            "program_code": program_code,
            "freshman": fr,
            "sophomore": so,
            "junior": jr,
            "senior": sr,
            "is_archived": False,
            "created_at": now2,
            "updated_at": now2,
        }
        if sdoc["program_id"] is None:
            del sdoc["program_id"]

        stat_docs.append(sdoc)

    if stat_docs:
        await db[COL_STATS].insert_many(stat_docs)

    return {"insertedCount": len(count_docs), "insertedStats": len(stat_docs)}
