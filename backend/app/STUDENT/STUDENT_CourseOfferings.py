from datetime import datetime, timezone
from typing import Any, Dict, Optional, List

from fastapi import APIRouter, HTTPException, Query, Body
from ..main import db

router = APIRouter(prefix="/student", tags=["student"])

# ---------------- collections ----------------
COL_TERMS = "terms"
COL_CURRICULUM = "curriculum"
COL_COURSES = "courses"

# These 3 may vary in your DB naming — update if needed:
COL_SECTIONS = "sections"
COL_SECTION_SCHEDULES = "section_schedules"
COL_ROOMS = "rooms"

# Faculty mapping (update if your project uses a different one)
# Option A: assignments collection with section_id -> user_id/faculty_id
COL_SECTION_FACULTY = "section_faculty"
COL_USERS = "users"

COL_PREEN_COUNT = "preenlistment_count"

# ---------------- helpers ----------------

def _now_dt() -> datetime:
    return datetime.now(timezone.utc)

async def _active_term() -> Dict[str, Any]:
    """
    Same logic style as petition: derive working/planning term.
    Priority:
    1) active pre-enlistment batch term_id
    2) next term after current
    3) current term
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

    return next_terms[0] if next_terms else current

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
        {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1, "units": 1},
    )
    if doc:
        cc = doc.get("course_code")
        if isinstance(cc, list):
            doc["course_code"] = cc[0] if cc else ""
    return doc

async def _is_course_offered_this_term(term_id: str, course_id: str) -> bool:
    if not term_id or not course_id:
        return False
    hit = await db[COL_CURRICULUM].find_one(
        {"term_id": term_id, "course_list": {"$in": [course_id]}},
        {"_id": 0, "term_id": 1},
    )
    return bool(hit)

def _safe_upper(s: Any) -> str:
    return str(s or "").strip().upper()

def _is_open(enrolled: Any, cap: Any) -> bool:
    try:
        e = int(enrolled or 0)
        c = int(cap or 0)
        if c <= 0:
            return False
        return e < c
    except:
        return False

# ---------------- route ----------------

@router.post("/course-offerings")
async def course_offerings_handler(
    userId: str = Query(..., min_length=3),
    action: str = Query("options", description="options | search"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    # ---------- OPTIONS ----------
    if action == "options":
        term = await _active_term()
        if not term.get("term_id"):
            return {
                "ok": False,
                "term": None,
                "courses": [],
                "message": "No active term found. Please configure a current term.",
            }

        term_id = term["term_id"]

        # Return courses offered in this term (for validation / future UI needs)
        pipeline = [
            {
                "$lookup": {
                    "from": COL_CURRICULUM,
                    "let": {"cid": "$course_id", "term": term_id},
                    "pipeline": [
                        {
                            "$match": {
                                "$expr": {
                                    "$and": [
                                        {"$eq": ["$term_id", "$$term"]},
                                        {"$in": ["$$cid", {"$ifNull": ["$course_list", []]}]},
                                    ]
                                }
                            }
                        },
                        {"$limit": 1},
                    ],
                    "as": "cur",
                }
            },
            {"$match": {"cur": {"$ne": []}}},
            {
                "$project": {
                    "_id": 0,
                    "course_id": 1,
                    "course_code": {
                        "$cond": [
                            {"$isArray": "$course_code"},
                            {"$ifNull": [{"$arrayElemAt": ["$course_code", 0]}, ""]},
                            {"$ifNull": ["$course_code", ""]},
                        ]
                    },
                    "course_title": 1,
                    "units": 1,
                }
            },
            {"$sort": {"course_code": 1}},
        ]
        courses = [c async for c in db[COL_COURSES].aggregate(pipeline)]

        return {"ok": True, "term": term, "courses": courses}

    # ---------- SEARCH ----------
    if action == "search":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload")

        code = _safe_upper(payload.get("courseCode"))
        if not code:
            raise HTTPException(status_code=400, detail="Course code is required.")

        term = await _active_term()
        term_id = term.get("term_id", "")
        if not term_id:
            raise HTTPException(status_code=503, detail="No active term configured.")

        course = await _find_course_by_code(code)
        if not course:
            raise HTTPException(status_code=404, detail="Course code not found.")

        offered = await _is_course_offered_this_term(term_id, course["course_id"])
        if not offered:
            raise HTTPException(status_code=400, detail="Course is not offered in the current term.")

        # Fetch sections for (term, course)
        sections = [s async for s in db[COL_SECTIONS].find(
            {"term_id": term_id, "course_id": course["course_id"]},
            {
                "_id": 0,
                "section_id": 1,
                "section_code": 1,
                "class_nbr": 1,
                "enrollment_cap": 1,
                "enrolled": 1,
                "remarks": 1,
            }
        ).sort([("section_code", 1)])]

        if not sections:
            return {"ok": True, "term": term, "course": course, "sections": []}

        section_ids = [s["section_id"] for s in sections if s.get("section_id")]

        # schedules
        sched_rows = [r async for r in db[COL_SECTION_SCHEDULES].find(
            {"section_id": {"$in": section_ids}},
            {"_id": 0, "section_id": 1, "day": 1, "start_time": 1, "end_time": 1, "room_id": 1}
        )]

        # rooms lookup
        room_ids = list({r.get("room_id") for r in sched_rows if r.get("room_id")})
        rooms = [rm async for rm in db[COL_ROOMS].find(
            {"room_id": {"$in": room_ids}},
            {"_id": 0, "room_id": 1, "room_number": 1, "room_type": 1}
        )] if room_ids else []

        room_map = {r["room_id"]: r for r in rooms}

        sched_by_section: Dict[str, List[Dict[str, Any]]] = {}
        for r in sched_rows:
            sid = r.get("section_id")
            if not sid:
                continue
            rm = room_map.get(r.get("room_id", ""), {})
            item = {
                "day": r.get("day"),
                "start_time": r.get("start_time"),
                "end_time": r.get("end_time"),
                "room_number": rm.get("room_number"),
                "room_type": rm.get("room_type"),
            }
            sched_by_section.setdefault(sid, []).append(item)

        # faculty mapping (best-effort)
        fac_rows = [f async for f in db[COL_SECTION_FACULTY].find(
            {"section_id": {"$in": section_ids}},
            {"_id": 0, "section_id": 1, "user_id": 1, "faculty_id": 1}
        )] if await db.list_collection_names() else []

        # normalize to user_ids (if your mapping uses faculty_id, adapt here)
        fac_user_ids = []
        fac_by_section: Dict[str, str] = {}
        for f in fac_rows:
            sid = f.get("section_id")
            uid = f.get("user_id") or f.get("faculty_id")
            if sid and uid:
                fac_by_section[sid] = uid
                fac_user_ids.append(uid)

        users = [u async for u in db[COL_USERS].find(
            {"user_id": {"$in": fac_user_ids}},
            {"_id": 0, "user_id": 1, "first_name": 1, "last_name": 1}
        )] if fac_user_ids else []

        user_map = {u["user_id"]: u for u in users}

        def faculty_name_for(section_id: str) -> str:
            uid = fac_by_section.get(section_id, "")
            u = user_map.get(uid)
            if not u:
                return ""
            return f"{(u.get('last_name') or '').strip()}, {(u.get('first_name') or '').strip()}".strip(", ").strip()

        # build response
        out_sections: List[Dict[str, Any]] = []
        for s in sections:
            sid = s.get("section_id", "")
            cap = s.get("enrollment_cap", 0)
            enrolled = s.get("enrolled", 0)
            out_sections.append({
                "section_id": sid,
                "class_nbr": s.get("class_nbr"),
                "section_code": s.get("section_code", ""),
                "enrollment_cap": cap,
                "enrolled": enrolled,
                "is_open": _is_open(enrolled, cap),
                "faculty_name": faculty_name_for(sid),
                "remarks": s.get("remarks", ""),
                "schedules": sched_by_section.get(sid, []),
            })

        return {"ok": True, "term": term, "course": course, "sections": out_sections}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
