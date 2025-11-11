from __future__ import annotations
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Body
from pymongo import ASCENDING, ReturnDocument
from bson import ObjectId

from ..main import db

router = APIRouter(prefix="/om", tags=["om"])

# --- collections ---
COL_CLASS_RETENTION = "class_retention"
COL_TERMS = "terms"
COL_COURSES = "courses"
COL_SECTIONS = "sections"
COL_USERS = "users"
COL_FAC_PROFILES = "faculty_profiles"

STATUS_OPTIONS = ["Approved", "Under Review", "Dissolved", "Special Class"]

# (If db is Motor, these are awaitables; if PyMongo, they just run. Safe to leave.)
try:
    db[COL_CLASS_RETENTION].create_index([("term_id", ASCENDING)])
    db[COL_CLASS_RETENTION].create_index([("course_id", ASCENDING)])
    db[COL_CLASS_RETENTION].create_index([("section_id", ASCENDING)])
    db[COL_CLASS_RETENTION].create_index([("faculty_id", ASCENDING)])
    db[COL_CLASS_RETENTION].create_index([("status", ASCENDING)])
    db[COL_CLASS_RETENTION].create_index([("updated_at", ASCENDING)])
except Exception:
    pass


def _course_code_expr() -> Dict[str, Any]:
    # handle array-or-scalar course_code
    return {
        "$ifNull": [
            {"$arrayElemAt": ["$course.course_code", 0]},
            {"$ifNull": ["$course.course_code", ""]},
        ]
    }


def _term_label_expr() -> Dict[str, Any]:
    # AY {acad_year_start}-{acad_year_start+1} · Term {term_number}
    return {
        "$concat": [
            "AY ",
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
            " · Term ",
            {"$toString": {"$ifNull": ["$term.term_number", ""]}},
        ]
    }


def _faculty_display_name_expr() -> Dict[str, Any]:
    return {
        "$ifNull": [
            {
                "$concat": [
                    {"$ifNull": ["$fac.last_name", ""]}, ", ",
                    {"$ifNull": ["$fac.first_name", ""]},
                    {
                        "$cond": [
                            {"$gt": [{"$strLenCP": {"$ifNull": ["$fac.middle_name", ""]}}, 0]},
                            {"$concat": [" ", {"$substrCP": ["$fac.middle_name", 0, 1]}, "."]},
                            "",
                        ]
                    },
                ]
            },
            {
                "$concat": [
                    {"$ifNull": ["$u.lastName", ""]}, ", ",
                    {"$ifNull": ["$u.firstName", ""]},
                ]
            },
        ]
    }


def _list_pipeline(term_id: Optional[str], status: Optional[str], q: Optional[str]) -> List[Dict[str, Any]]:
    match: Dict[str, Any] = {}
    if term_id:
        match["term_id"] = term_id
    if status and status not in ("All Status", ""):
        match["status"] = status

    pipeline: List[Dict[str, Any]] = [
        {"$match": match},
        {"$lookup": {"from": COL_TERMS, "localField": "term_id", "foreignField": "term_id", "as": "term"}},
        {"$unwind": {"path": "$term", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": COL_COURSES, "localField": "course_id", "foreignField": "course_id", "as": "course"}},
        {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": COL_SECTIONS, "localField": "section_id", "foreignField": "section_id", "as": "section"}},
        {"$unwind": {"path": "$section", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": COL_FAC_PROFILES, "localField": "faculty_id", "foreignField": "faculty_id", "as": "fac"}},
        {"$unwind": {"path": "$fac", "preserveNullAndEmptyArrays": True}},
        {"$lookup": {"from": COL_USERS, "localField": "faculty_id", "foreignField": "userId", "as": "u"}},
        {"$unwind": {"path": "$u", "preserveNullAndEmptyArrays": True}},
    ]

    if q:
        pipeline.append({
            "$match": {
                "$or": [
                    {"course.course_code": {"$regex": q, "$options": "i"}},
                    {"course.course_title": {"$regex": q, "$options": "i"}},
                    {"section.section_code": {"$regex": q, "$options": "i"}},
                ]
            }
        })

    pipeline += [
        {"$project": {
            "_id": 0,
            "retention_id": {"$toString": "$_id"},
            "term_id": 1, "course_id": 1, "section_id": 1, "faculty_id": 1,
            "student_units": 1, "faculty_units": 1, "status": 1,
            "created_at": 1, "updated_at": 1,
            "enrolled": {"$ifNull": ["$enrolled", "$section.enrolled"]},
            "term_label": _term_label_expr(),
            "course_code": _course_code_expr(),
            "course_title": {"$ifNull": ["$course.course_title", ""]},
            "section_code": {"$ifNull": ["$section.section_code", ""]},
            "faculty_name": _faculty_display_name_expr(),
        }},
        {"$sort": {"course_code": 1, "section_code": 1}},
    ]
    return pipeline


async def _find_active_term() -> Optional[Dict[str, Any]]:
    active = await db[COL_TERMS].find_one(
        {"$or": [{"is_current": True}, {"is_active": True}, {"active": True}, {"status": "Active"}]},
        {"_id": 0, "term_id": 1, "term_number": 1, "acad_year_start": 1},
    )
    if active:
        return active
    return await db[COL_TERMS].find_one(
        {}, {"_id": 0, "term_id": 1, "term_number": 1, "acad_year_start": 1},
        sort=[("acad_year_start", -1), ("term_number", -1)],
    )


@router.get("/classretention")
async def cr_get(
    action: str = Query(...),
    term_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    course_id: Optional[str] = Query(None),  # needed for sectionOptions
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
            label = f"AY {ay}-{ay+1} · Term {tn}"
        return {
            "ok": True,
            "statuses": STATUS_OPTIONS,
            "terms": [
                {
                    "term_id": t["term_id"],
                    "label": f"AY {t.get('acad_year_start','')}-{(t.get('acad_year_start') or 0)+1} · Term {t.get('term_number','')}",
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
            {"$lookup": {
                "from": COL_COURSES,
                "localField": "_id",
                "foreignField": "course_id",
                "as": "c"
            }},
            {"$unwind": {"path": "$c", "preserveNullAndEmptyArrays": True}},
            {"$project": {
                "_id": 0,
                "course_id": {"$ifNull": ["$c.course_id", "$_id"]},
                "course_code": {"$ifNull": ["$c.course_code", ""]},
                "course_title": {"$ifNull": ["$c.course_title", ""]},
            }},
            {"$sort": {"course_code": 1}}
        ]
        opts = await db[COL_SECTIONS].aggregate(pipeline).to_list(length=5000)
        return {"ok": True, "options": opts}

    # --- dropdown helpers: section options by course for active term ---
    if action == "sectionOptions":
        t = term_id
        if not t:
            active = await _find_active_term()
            t = active.get("term_id") if active else None
        if not t or not course_id:
            return {"ok": True, "options": []}

        cur = db[COL_SECTIONS].find(
            {"term_id": t, "course_id": course_id},
            {"_id": 0, "section_id": 1, "section_code": 1, "enrolled": 1},
        ).sort([("section_code", 1)])
        opts = await cur.to_list(length=5000)
        return {"ok": True, "options": opts}

    # --- fallback ---
    raise HTTPException(status_code=400, detail="Unsupported action")


def _to_int_or_none(v) -> Optional[int]:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except Exception:
        raise HTTPException(status_code=400, detail="enrolled must be an integer")


@router.post("/classretention")
async def cr_post(action: str = Query(...), payload: Dict[str, Any] = Body(default={})):
    now = datetime.utcnow()

    if action == "save":
        rid = payload.get("retention_id")

        if "enrolled" in payload:
            payload["enrolled"] = _to_int_or_none(payload.get("enrolled"))
            if payload["enrolled"] is not None and payload["enrolled"] < 0:
                raise HTTPException(status_code=400, detail="enrolled must be >= 0")

        if rid:
            try:
                _id = ObjectId(rid)
            except Exception:
                raise HTTPException(status_code=400, detail="Invalid retention_id")

            allowed = [
                "term_id", "course_id", "section_id", "faculty_id",
                "student_units", "faculty_units", "status", "enrolled",
            ]
            update_doc = {k: payload[k] for k in allowed if k in payload}
            if "status" in update_doc and update_doc["status"] not in STATUS_OPTIONS:
                raise HTTPException(status_code=400, detail="Invalid status")
            update_doc["updated_at"] = now

            out = await db[COL_CLASS_RETENTION].find_one_and_update(
                {"_id": _id},
                {"$set": update_doc},
                return_document=ReturnDocument.AFTER,
            )
            if not out:
                raise HTTPException(status_code=404, detail="Retention row not found")

            # reflect enrolled to sections collection when provided
            if "enrolled" in payload:
                section_id = payload.get("section_id") or out.get("section_id")
                if section_id:
                    await db[COL_SECTIONS].update_one(
                        {"section_id": section_id},
                        {"$set": {"enrolled": payload["enrolled"], "updated_at": now}},
                    )
            return {"ok": True, "retention_id": rid}

        # create
        for k in ("term_id", "course_id", "section_id", "faculty_id"):
            if not payload.get(k):
                raise HTTPException(status_code=400, detail=f"{k} is required")

        status = payload.get("status", "Under Review")
        if status not in STATUS_OPTIONS:
            raise HTTPException(status_code=400, detail="Invalid status")

        doc = {
            "term_id": payload["term_id"],
            "course_id": payload["course_id"],
            "section_id": payload["section_id"],
            "faculty_id": payload["faculty_id"],
            "student_units": payload.get("student_units"),
            "faculty_units": payload.get("faculty_units"),
            "status": status,
            "enrolled": payload.get("enrolled"),
            "created_at": now,
            "updated_at": now,
        }
        res = await db[COL_CLASS_RETENTION].insert_one(doc)

        # reflect enrolled to section if provided
        if doc.get("enrolled") is not None:
            await db[COL_SECTIONS].update_one(
                {"section_id": doc["section_id"]},
                {"$set": {"enrolled": doc["enrolled"], "updated_at": now}},
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
        res = await db[COL_CLASS_RETENTION].update_many(
            {"_id": {"$in": obj_ids}},
            {"$set": {"status": new_status, "updated_at": now}},
        )
        return {"ok": True, "matched": res.matched_count, "modified": res.modified_count}

    raise HTTPException(status_code=400, detail="Unsupported action")
