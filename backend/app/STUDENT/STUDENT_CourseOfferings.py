from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, HTTPException, Query

from ..main import db

router = APIRouter(prefix="/student", tags=["student"])

# ---------------- collections ----------------
COL_TERMS = "terms"
COL_PREEN_COUNT = "preenlistment_count"

COL_COURSES = "courses"
COL_SECTIONS = "sections"
COL_SECTION_SCHEDULES = "section_schedules"
COL_ROOMS = "rooms"

COL_FAC_ASSIGN = "faculty_assignments"
COL_FAC_PROFILES = "faculty_profiles"
COL_USERS = "users"


# ---------------- helpers ----------------
def _now_dt() -> datetime:
    return datetime.now(timezone.utc)


async def _active_term() -> Dict[str, Any]:
    """
    Priority:
    1) active pre-enlistment batch (preenlistment_count where not archived)
    2) next term after current (status=active OR is_current=True)
    3) fallback latest
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
        fallback = (
            await db[COL_TERMS]
            .find({}, {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1})
            .sort([("acad_year_start", -1), ("term_number", -1)])
            .limit(1)
            .to_list(1)
        )
        current = fallback[0] if fallback else None

    if not current:
        return {}

    next_terms = (
        await db[COL_TERMS]
        .find(
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
        )
        .sort([("acad_year_start", 1), ("term_number", 1)])
        .limit(1)
        .to_list(1)
    )

    if next_terms:
        return next_terms[0]
    return current


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
    if not doc:
        return None

    cc = doc.get("course_code")
    if isinstance(cc, list):
        doc["course_code"] = cc[0] if cc else ""
    return doc


def _norm_hhmm(v: Any) -> str:
    s = str(v or "").strip()
    if not s:
        return ""
    # allow "0730", "07:30"
    s = s.replace(":", "")
    if len(s) == 3:
        s = "0" + s
    if len(s) != 4 or not s.isdigit():
        return ""
    return s


def _day_code(v: Any) -> str:
    s = str(v or "").strip().upper()
    if not s:
        return ""
    # keep single-letter codes used in your system (M/T/W/H/F/S) or accept full names
    if s in {"M", "T", "W", "H", "F", "S"}:
        return s
    # normalize common full day names
    m = {
        "MONDAY": "M",
        "TUESDAY": "T",
        "WEDNESDAY": "W",
        "THURSDAY": "H",
        "FRIDAY": "F",
        "SATURDAY": "S",
        "SUN": "S",
        "SUNDAY": "S",
    }
    return m.get(s, s[:1])


def _full_name(u: Dict[str, Any]) -> str:
    fn = str(u.get("first_name") or "").strip()
    ln = str(u.get("last_name") or "").strip()
    mid = str(u.get("middle_name") or "").strip()
    if not (fn or ln):
        return ""
    if mid:
        return f"{ln}, {fn} {mid}".strip()
    return f"{ln}, {fn}".strip()


# ---------------- route ----------------
@router.post("/course-offerings")
async def student_course_offerings(
    userId: str = Query(..., min_length=3),
    action: str = Query("options", description="options | search"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    # -------- OPTIONS --------
    if action == "options":
        term = await _active_term()

        # minimal course list for student searching/autofill
        pipeline = [
            {"$project": {
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
                "units": {"$ifNull": ["$units", 0]},
            }},
            {"$match": {"course_code": {"$ne": ""}}},
            {"$sort": {"course_code": 1}},
        ]
        courses = [c async for c in db[COL_COURSES].aggregate(pipeline)]

        return {"ok": True, "term": term, "courses": courses}

    # -------- SEARCH --------
    if action == "search":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload")

        code = str(payload.get("courseCode") or "").strip().upper()
        if not code:
            raise HTTPException(status_code=400, detail="courseCode is required")

        term = await _active_term()
        term_id = term.get("term_id")
        if not term_id:
            raise HTTPException(status_code=503, detail="No active term configured.")

        course = await _find_course_by_code(code)
        if not course:
            return {"ok": True, "term": term, "course": {"course_code": code}, "sections": []}

        # sections for course + term
        sec_docs = await db[COL_SECTIONS].find(
            {"term_id": term_id, "course_id": course["course_id"]},
            {
                "_id": 0,
                "section_id": 1,
                "section_code": 1,
                "enrollment_cap": 1,
                "enrolled": 1,
                "status": 1,
                "remarks": 1,
            },
        ).sort([("section_code", 1)]).to_list(None)

        section_ids = [s.get("section_id") for s in sec_docs if s.get("section_id")]
        if not section_ids:
            return {"ok": True, "term": term, "course": {
                "course_code": course.get("course_code", ""),
                "course_title": course.get("course_title", ""),
                "units": course.get("units", 0),
            }, "sections": []}

        # schedules by section_id
        sched_docs = await db[COL_SECTION_SCHEDULES].find(
            {"section_id": {"$in": section_ids}},
            {"_id": 0, "section_id": 1, "day": 1, "day_code": 1, "start_time": 1, "end_time": 1,
             "begin": 1, "end": 1, "room_id": 1, "room_number": 1, "room_type": 1},
        ).to_list(None)

        # rooms lookup (if schedules reference room_id)
        room_ids = [x.get("room_id") for x in sched_docs if x.get("room_id")]
        room_map: Dict[str, Dict[str, Any]] = {}
        if room_ids:
            rooms = await db[COL_ROOMS].find(
                {"room_id": {"$in": list({r for r in room_ids if r})}},
                {"_id": 0, "room_id": 1, "room_number": 1, "room_type": 1},
            ).to_list(None)
            room_map = {r["room_id"]: r for r in rooms if r.get("room_id")}

        sched_by_section: Dict[str, List[Dict[str, Any]]] = {sid: [] for sid in section_ids}
        for sc in sched_docs:
            sid = sc.get("section_id")
            if not sid:
                continue

            day = _day_code(sc.get("day_code") or sc.get("day"))
            st = _norm_hhmm(sc.get("start_time") or sc.get("begin"))
            en = _norm_hhmm(sc.get("end_time") or sc.get("end"))

            rn = str(sc.get("room_number") or "").strip()
            rt = str(sc.get("room_type") or "").strip()

            rid = sc.get("room_id")
            if rid and rid in room_map:
                rm = room_map[rid]
                rn = rn or str(rm.get("room_number") or "").strip()
                rt = rt or str(rm.get("room_type") or "").strip()

            sched_by_section.setdefault(sid, []).append({
                "day": day or "",
                "start_time": st or "",
                "end_time": en or "",
                "room_number": rn or "",
                "room_type": rt or "",
            })

        # faculty assignments by section (FIX: always resolve faculty name)
        fac_assign = await db[COL_FAC_ASSIGN].find(
            {"section_id": {"$in": section_ids}},
            {"_id": 0, "section_id": 1, "faculty_id": 1, "faculty_name": 1},
        ).to_list(None)

        fac_by_section: Dict[str, str] = {}
        faculty_ids: List[str] = []

        for fa in fac_assign:
            sid = fa.get("section_id")
            if not sid or sid in fac_by_section:
                continue

            nm = str(fa.get("faculty_name") or "").strip()
            fid = str(fa.get("faculty_id") or "").strip()

            if nm:
                fac_by_section[sid] = nm
            else:
                # will resolve later from profiles/users
                fac_by_section[sid] = ""
                if fid:
                    faculty_ids.append(fid)

        # resolve missing faculty names from faculty_profiles -> users
        faculty_ids = list({x for x in faculty_ids if x})
        if faculty_ids:
            profs = await db[COL_FAC_PROFILES].find(
                {"faculty_id": {"$in": faculty_ids}},
                {"_id": 0, "faculty_id": 1, "user_id": 1},
            ).to_list(None)
            facid_to_userid = {p["faculty_id"]: p.get("user_id") for p in profs if p.get("faculty_id")}

            user_ids = list({uid for uid in facid_to_userid.values() if uid})
            users = []
            if user_ids:
                users = await db[COL_USERS].find(
                    {"user_id": {"$in": user_ids}},
                    {"_id": 0, "user_id": 1, "first_name": 1, "last_name": 1, "middle_name": 1},
                ).to_list(None)
            user_map = {u["user_id"]: u for u in users if u.get("user_id")}

            facid_to_name: Dict[str, str] = {}
            for fid, uid in facid_to_userid.items():
                u = user_map.get(uid or "")
                if u:
                    facid_to_name[fid] = _full_name(u)

            # fill missing names
            for fa in fac_assign:
                sid = fa.get("section_id")
                if not sid:
                    continue
                if fac_by_section.get(sid):  # already has name
                    continue
                fid = str(fa.get("faculty_id") or "").strip()
                fac_by_section[sid] = facid_to_name.get(fid, "")

        # Build output rows
        out_sections: List[Dict[str, Any]] = []
        for s in sec_docs:
            sid = s.get("section_id", "")
            cap = int(s.get("enrollment_cap") or 0)
            enr = int(s.get("enrolled") or 0)

            # if "status" exists and indicates open/closed, still compute safe
            is_open = True
            st = str(s.get("status") or "").strip().lower()
            if st in {"inactive", "closed"}:
                is_open = False
            if cap > 0 and enr >= cap:
                is_open = False

            out_sections.append({
                "section_id": sid,
                "section_code": s.get("section_code") or "",
                "enrollment_cap": cap,
                "enrolled": enr,
                "is_open": is_open,
                "faculty_name": (fac_by_section.get(sid) or "").strip(),  # ✅ fixed
                "remarks": s.get("remarks") or "",
                "schedules": sched_by_section.get(sid, []),
            })

        return {
            "ok": True,
            "term": term,
            "course": {
                "course_code": course.get("course_code", ""),
                "course_title": course.get("course_title", ""),
                "units": course.get("units", 0),
            },
            "sections": out_sections,
        }

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
