# analytics/app/OM_REPORTS_ANALYTICS/OM_RP_CourseProfile.py
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..db_async import get_db  # reuse the shared Mongo client

router = APIRouter()

async def get_course_profile_for(query: str) -> Dict[str, Any]:
    """
    Returns Course Profile payload for a given course_id or course_code.
    (Moved from db_async.py to this module.)
    """
    db = get_db()
    q = (query or "").strip()
    if not q:
        return {"course_id": "", "title": "Not found"}

    # 1) find course by id OR element of course_code[] (case-insensitive)
    course = await db.courses.find_one({
        "$or": [
            {"course_id":   {"$regex": f"^{q}$", "$options": "i"}},
            {"course_code": {"$elemMatch": {"$regex": f"^{q}$", "$options": "i"}}},
        ]
    })
    if not course:
        return {"course_id": q, "title": "Not found"}

    course_id   = course.get("course_id")
    course_code = course.get("course_code") or []
    title       = course.get("course_title") or course.get("title") or ""

    # KACs that include this course
    kac_docs = await db.kacs.find(
        {"course_list": course_id},
        {"kac_id": 1, "course_list": 1}
    ).to_list(None)

    kac_ids = [k["kac_id"] for k in kac_docs]

    # -------- Qualified faculty (union of: taught this course ∪ qualified via KAC) --------
    qualified: List[Dict[str, Any]] = []
    if kac_ids:
        # A) taught THIS course
        sec_ids = await db.sections.distinct("section_id", {"course_id": course_id})
        taught_ids = set()
        if sec_ids:
            taught_ids = set(await db.faculty_assignments.distinct(
                "faculty_id", {"section_id": {"$in": sec_ids}}
            ))

        # B) KAC-qualified
        kac_qualified_ids = set(await db.faculty_profiles.distinct(
            "faculty_id", {"qualified_kacs": {"$in": kac_ids}}
        ))

        fac_ids = sorted(taught_ids | kac_qualified_ids)
        if fac_ids:
            fps = await db.faculty_profiles.find(
                {"faculty_id": {"$in": fac_ids}}, {"faculty_id": 1, "user_id": 1}
            ).to_list(None)
            prof_by_fid = {fp["faculty_id"]: fp for fp in fps}

            user_ids = {fp.get("user_id") for fp in fps if fp.get("user_id")} | set(fac_ids)
            users = await db.users.find(
                {"user_id": {"$in": list(user_ids)}},
                {"user_id": 1, "first_name": 1, "last_name": 1, "email": 1}
            ).to_list(None)
            user_by_uid = {u["user_id"]: u for u in users}

            for fid in fac_ids:
                uid = (prof_by_fid.get(fid) or {}).get("user_id") or fid
                u = user_by_uid.get(uid, {})
                source_bits = []
                if fid in kac_qualified_ids:
                    source_bits.append("Qualified KAC")
                if fid in taught_ids:
                    source_bits.append("Teaching History")

                qualified.append({
                    "faculty_id": fid,
                    "first_name": u.get("first_name"),
                    "last_name":  u.get("last_name"),
                    "email":      u.get("email"),
                    "source":     " & ".join(source_bits) if source_bits else "—",
                })

    # -------- Past instructors (aggregated) --------
    past: List[Dict[str, Any]] = []
    pipeline = [
        {"$match": {"course_id": course_id}},
        {"$lookup": {
            "from": "faculty_assignments",
            "localField": "section_id",
            "foreignField": "section_id",
            "as": "fa"
        }},
        {"$unwind": "$fa"},
        {"$lookup": {
            "from": "terms",
            "localField": "term_id",
            "foreignField": "term_id",
            "as": "term"
        }},
        {"$unwind": {"path": "$term", "preserveNullAndEmptyArrays": True}},
        {"$project": {
            "_id": 0,
            "faculty_id": "$fa.faculty_id",
            "section_id": 1,
            "section_code": 1,
            "term_id": 1,
            "acad_year_start": "$term.acad_year_start",
            "term_number": "$term.term_number",
        }},
        {"$group": {
            "_id": "$faculty_id",
            "sections": {"$push": {
                "course_code": course_code,
                "section_id": "$section_id",
                "section_code": "$section_code",
                "term_id": "$term_id",
                "acad_year_start": "$acad_year_start",
                "term_number": "$term_number",
            }},
            "count": {"$sum": 1}
        }},
        {"$lookup": {
            "from": "faculty_profiles",
            "localField": "_id",
            "foreignField": "faculty_id",
            "as": "fp"
        }},
        {"$unwind": {"path": "$fp", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {
            "from": "users",
            "let": { "uid": "$fp.user_id", "fid": "$_id" },
            "pipeline": [
                { "$match": {
                    "$expr": { "$or": [
                        { "$eq": ["$user_id", "$$uid"] },
                        { "$eq": ["$user_id", "$$fid"] }
                    ]}
                }},
                { "$project": { "first_name": 1, "last_name": 1, "email": 1 } }
            ],
            "as": "user"
        }},
        {"$unwind": { "path": "$user", "preserveNullAndEmptyArrays": True }},
        {"$project": {
            "_id": 0,
            "faculty_id": { "$toString": "$_id" },
            "first_name": "$user.first_name",
            "last_name":  "$user.last_name",
            "email":      "$user.email",
            "count": 1,
            "sections": 1
        }},
        {"$sort": { "count": -1, "last_name": 1, "first_name": 1 }},
    ]

    async for row in db.sections.aggregate(pipeline, allowDiskUse=True):
        past.append({
            "faculty_id": row["faculty_id"],
            "first_name": row.get("first_name"),
            "last_name":  row.get("last_name"),
            "email":      row.get("email"),
            "count":      row.get("count", 0),
            "sections":   [
                {
                    "course_code": s.get("course_code") or [],
                    "section_id": s.get("section_id"),
                    "section_code": s.get("section_code"),
                    "term_id": s.get("term_id"),
                    "acad_year_start": s.get("acad_year_start"),
                    "term_number": s.get("term_number"),
                } for s in row.get("sections", [])
            ]
        })

    # -------- Preferences for current term --------
    preferences: Any = "N/A"
    current = await db.terms.find_one({"is_current": True}, {"term_id": 1})
    prefs_list: List[Dict[str, Any]] = []

    if current and kac_ids:
        pipeline_prefs = [
            {"$match": {
                "term_id": current["term_id"],
                "preferred_kacs": {"$in": kac_ids}
            }},
            {"$lookup": {
                "from": "faculty_profiles",
                "localField": "faculty_id",
                "foreignField": "faculty_id",
                "as": "fp"
            }},
            {"$unwind": {"path": "$fp", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {
                "from": "users",
                "let": {"uid": "$fp.user_id", "fid": "$faculty_id"},
                "pipeline": [
                    {"$match": {"$expr": {"$or": [
                        {"$eq": ["$user_id", "$$uid"]},
                        {"$eq": ["$user_id", "$$fid"]}
                    ]}}},
                    {"$project": {"first_name": 1, "last_name": 1, "email": 1}}
                ],
                "as": "user"
            }},
            {"$unwind": {"path": "$user", "preserveNullAndEmptyArrays": True}},
            {"$project": {
                "_id": 0,
                "faculty_id": 1,
                "first_name": "$user.first_name",
                "last_name":  "$user.last_name",
                "email":      "$user.email",
            }},
            {"$sort": {"last_name": 1, "first_name": 1}}
        ]

        async for row in db.faculty_preferences.aggregate(pipeline_prefs, allowDiskUse=True):
            prefs_list.append({
                "faculty_id": row.get("faculty_id"),
                "first_name": row.get("first_name"),
                "last_name":  row.get("last_name"),
                "email":      row.get("email"),
            })

        if prefs_list:
            preferences = prefs_list
        else:
            preferences = f"No faculty preference submissions yet for current term {current['term_id']}."
    elif current and not kac_ids:
        preferences = f"No matching KAC lists this course for current term {current['term_id']}."
    else:
        preferences = "No current term found."

    return {
        "course_id": course_id,
        "course_code": course_code,
        "title": title,
        "qualified_faculty": qualified,
        "past_instructors": past,
        "preferences": preferences,
    }

# HTTP endpoint (same URL your frontend calls)
@router.get("/analytics/course-profile-for")
async def course_profile_for(query: str = Query(..., description="course_id or course_code")):
    data = await get_course_profile_for(query)
    return JSONResponse(content=data)
