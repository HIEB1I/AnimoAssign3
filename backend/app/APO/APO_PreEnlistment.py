# backend/app/APO/APO_PreEnlistment.py
from datetime import datetime
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Query, Body
from ..main import db  # shared Motor client/db

router = APIRouter(prefix="/apo", tags=["apo"])

def _now() -> datetime:
    return datetime.utcnow()

def _new_id(prefix: str) -> str:
    return f"{prefix}{int(datetime.utcnow().timestamp() * 1000)}"

def _campus_to_id(campus: str) -> str:
    s = (campus or "").strip().upper()
    if s == "MANILA":
        return "CMPS001"
    if s == "LAGUNA":
        return "CMPS002"
    return ""

# -------------------- SINGLE ROUTE (GET + POST) --------------------

@router.get("/preenlistment")
async def get_preenlistment(
    userId: str = Query(..., min_length=3),
    termId: str = Query("TERM_2025_T1"),
):
    """
    Single GET endpoint that returns BOTH datasets:
      - count: rows for this APO (separation via user_id)
      - statistics: shared stats
    """
    count_cur = db["preenlistment_count"].find(
        {"user_id": userId, "term_id": termId},
        {"_id": 0},
    )
    stats_cur = db["preenlistment_statistics"].find(
        {"term_id": termId},
        {"_id": 0},
    )
    count = [doc async for doc in count_cur]
    statistics = [doc async for doc in stats_cur]
    return {"count": count, "statistics": statistics}

@router.post("/preenlistment")
async def import_preenlistment(
    payload: Dict[str, Any] = Body(..., description="""
      { 
        "countRows": [ { "Code": "...", "Career": "...", "Acad Group": "...", "Campus": "MANILA|LAGUNA", "Course Code": "...", "Count": 123 }, ... ],
        "statRows":  [ { "Program": "...", "FRESHMAN": n, "SOPHOMORE": n, "JUNIOR": n, "SENIOR": n }, ... ]
      }
    """),
    userId: str = Query(..., min_length=3),
    termId: str = Query("TERM_2025_T1"),
    replaceCount: bool = Query(False),
    replaceStats: bool = Query(False),
):
    """
    Single POST endpoint that imports BOTH datasets in one call.
    CSV headers must match exactly.
    """
    count_rows: List[Dict[str, Any]] = payload.get("countRows") or []
    stat_rows: List[Dict[str, Any]] = payload.get("statRows") or []

    if replaceCount:
        await db["preenlistment_count"].delete_many({"user_id": userId, "term_id": termId})
    if replaceStats:
        await db["preenlistment_statistics"].delete_many({"term_id": termId})

    # ----- transform & insert count rows -----
    count_docs: List[Dict[str, Any]] = []
    now = _now()
    for r in count_rows:
        code = (r.get("Code") or "").strip()
        career = (r.get("Career") or "").strip()
        acad_group = (r.get("Acad Group") or "").strip()
        campus = (r.get("Campus") or "").strip()
        course_code = (r.get("Course Code") or "").strip()
        cnt = r.get("Count", 0)

        if not (career and acad_group and campus and course_code):
            continue

        try:
            count_int = int(cnt)
        except Exception:
            count_int = 0

        count_docs.append({
            "count_id": _new_id("PRCNT"),
            "code": code,
            "career": career,
            "acad_group": acad_group,
            "campus": campus,                      
            "course_code": course_code,
            "count": count_int,
            "campus_id": _campus_to_id(campus),    
            "user_id": userId,                  
            "term_id": termId,
            "created_at": now,
            "updated_at": now,
        })

    if count_docs:
        await db["preenlistment_count"].insert_many(count_docs)

    # ----- transform & insert stat rows -----
    stat_docs: List[Dict[str, Any]] = []
    now2 = _now()
    for r in stat_rows:
        program = (r.get("Program") or "").strip()
        if not program:
            continue
        try:
            fr = int(r.get("FRESHMAN", 0))
            so = int(r.get("SOPHOMORE", 0))
            jr = int(r.get("JUNIOR", 0))
            sr = int(r.get("SENIOR", 0))
        except Exception:
            fr = so = jr = sr = 0

        stat_docs.append({
            "stat_id": _new_id("PRSTAT"),
            "program": program,
            "freshman": fr,
            "sophomore": so,
            "junior": jr,
            "senior": sr,
            "term_id": termId,
            "created_at": now2,
            "updated_at": now2,
        })

    if stat_docs:
        await db["preenlistment_statistics"].insert_many(stat_docs)

    return {"insertedCount": len(count_docs), "insertedStats": len(stat_docs)}
