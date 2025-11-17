# backend/app/CHAIR/CHAIR_Plantilla.py
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel

from ..main import db

router = APIRouter(prefix="/chair", tags=["chair"])

# ---------- Collections ----------
COL_TERMS = "terms"
COL_PREEN_COUNT = "preenlistment_count"


async def _active_term() -> Dict[str, Any]:
    """
    Return the PLANNING term (The term AFTER the currently active term).

    Logic:
    1. Find the "Active/Current" term in the `terms` collection.
    2. Query for the immediate next term (Next Term Number OR Next Acad Year).
    3. If a next term exists, return it.
    4. If no next term exists (end of configured terms), return the current active term.
    """

    # (1) Find "Current" term by flags
    current = await db[COL_TERMS].find_one(
        {
            "$or": [
                {"status": "active"},
                {"status": "Active"},
                {"is_current": True},
                {"is_active": True},
                {"active": True},
            ]
        },
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )

    # Fallback: If no term is flagged active, take the latest one based on date
    if not current:
        last = await db[COL_TERMS].find(
            {},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
        ).sort(
            [("acad_year_start", -1), ("term_number", -1)]
        ).limit(1).to_list(1)
        current = last[0] if last else None

    # If still no terms exist in DB, return empty
    if not current:
        return {}

    # (2) Find the "Next" term (Planning Term)
    # Strict Logic: Start Year > Current OR (Same Year AND Term > Current)
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
    ).sort(
        # Sort ASC to get the immediate next term
        [("acad_year_start", 1), ("term_number", 1)]
    ).limit(1).to_list(1)

    if next_terms:
        return next_terms[0]

    # No “next” term configured → stick with current
    return current


# ---------------- Models (response helpers) ----------------
class PlantillaRow(BaseModel):
    faculty_name: str
    course_code: str
    section_code: str
    day_text: str
    time_text: str
    room_text: str
    student_count: Optional[int] = None
    lec_hours: Optional[float] = None
    lab_hours: Optional[float] = None
    student_units: Optional[float] = None
    on_leave: str = "N/A"
    course_type: str = "N/A"
    nature_teaching: Optional[float] = None
    nature_admin: Optional[float] = None
    nature_research: Optional[float] = None
    nature_faculty_units: Optional[float] = None
    premium_grad: Optional[float] = None
    premium_4th_prep: Optional[float] = None
    premium_overload: Optional[float] = None
    remarks: str = "—"


def _fmt_time(start: str, end: str) -> str:
    """Formats DB times like '730' into '7:30' etc. Returns '—' if blank."""
    def to_hhmm(t: str) -> Optional[str]:
        t = (t or "").strip()
        if not t or not t.isdigit():
            return None
        if len(t) == 3:
            hh, mm = t[:1], t[-2:]
        else:
            hh, mm = t[:2], t[-2:]
        try:
            h = int(hh)
            m = int(mm)
        except ValueError:
            return None
        return f"{h}:{str(m).zfill(2)}"

    b = to_hhmm(start)
    e = to_hhmm(end)
    if b and e:
        return f"{b}–{e}"
    return b or e or "—"


# ---------------- API ----------------
@router.get("/plantilla")
async def chair_plantilla_get(
    userId: Optional[str] = Query(None),
    action: str = Query("header")  # header | fetch | options
) -> Dict[str, Any]:
    """
    GET /api/chair/plantilla?action=...
    - header: profile/term labels + defaults
    - fetch : plantilla rows for PLANNING term + user's department
    """
    if action == "header":
        profile_name = " "
        profile_subtitle = "Department Chair"
        dept_label = "Department"
        plantilla_file = "Faculty_Plantilla.xls"
        term_label: Optional[str] = None

        if userId:
            u = await db.users.find_one({"user_id": userId}) or {}
            first = (u.get("first_name") or "").strip()
            last  = (u.get("last_name")  or "").strip()
            full_name = " ".join(p for p in [first, last] if p).strip()
            profile_name = full_name or " "

            sp = await db.staff_profiles.find_one({"user_id": userId}) or {}
            if sp.get("position_title"):
                profile_subtitle = sp["position_title"]
           
            dept_name: Optional[str] = None
            dept_id = sp.get("department_id") or sp.get("dept_id")

            if not dept_id:
                ra = await db.role_assignments.find(
                    {
                        "user_id": userId,
                        "is_active": {"$in": [True, None]},
                        "$or": [
                            {"department_id": {"$exists": True, "$ne": None}},
                            {"dept_id": {"$exists": True, "$ne": None}},
                        ],
                    }
                ).sort([("updated_at", -1), ("created_at", -1)]).to_list(1)
                if ra:
                    dept_id = ra[0].get("department_id") or ra[0].get("dept_id")

            if not dept_id:
                fprof = await db.faculty_profiles.find_one({"user_id": userId}) or {}
                dept_id = fprof.get("department_id") or fprof.get("dept_id")

            if dept_id:
                d = await db.departments.find_one({"department_id": dept_id}) \
                    or await db.departments.find_one({"dept_id": dept_id}) \
                    or {}
                dept_name = d.get("dept_name") or d.get("name")

            if dept_name:
                profile_subtitle = f"{profile_subtitle} | {dept_name}"
                dept_label = dept_name

        active_term = await _active_term()
        if active_term:
            ay = active_term.get("acad_year_start")
            tn = active_term.get("term_number")
            if ay and tn:
                term_label = f"Term {tn} · AY {ay}-{int(ay) + 1}"

        return {
            "ok": True,
            "profileName": profile_name,
            "full_name": profile_name,
            "profileSubtitle": profile_subtitle,
            "term_label": term_label,
            "dept_label": dept_label,
            "plantilla_file": plantilla_file,
        }

    if action == "options":
        return {"ok": True, "buttons": [
            {"label": "Plantilla", "to": "/chair/plantilla"},
            {"label": "Faculty Directory", "to": "/chair/faculty-management"},
            {"label": "Course Management", "to": "/chair/course-management"},
            {"label": "Faculty Service", "to": "/chair/faculty-service"},
            {"label": "Student Petition", "to": "/chair/student-petitions"},
            {"label": "Class Retention", "to": "/chair/class-retention"},
        ]}

    if action == "fetch":
        # Get Planning Term
        term = await _active_term()
        term_id = term.get("term_id") if term else None

        # Sections for that term
        sec_match = {"term_id": term_id} if term_id else {}
        section_docs = await db.sections.find(sec_match).to_list(10000)

        # Fallback: If no sections, try to guess from assignments
        asg_docs: List[dict] = []
        if not section_docs:
            asg_docs = await db.faculty_assignments.find(
                {"is_archived": {"$in": [False, None]}}
            ).to_list(100000)

            sec_ids = list({a.get("section_id") for a in asg_docs if a.get("section_id")})
            if sec_ids:
                section_docs = await db.sections.find({"section_id": {"$in": sec_ids}}).to_list(10000)
        
        if not asg_docs and section_docs:
            asg_docs = await db.faculty_assignments.find(
                {"section_id": {"$in": [s.get("section_id") for s in section_docs]},
                 "is_archived": {"$in": [False, None]}}
            ).to_list(100000)

        by_section = {s["section_id"]: s for s in section_docs}

        # Map related data
        course_ids = list({s.get("course_id") for s in section_docs if s.get("course_id")})
        course_docs = []
        if course_ids:
            course_docs = await db.courses.find({"course_id": {"$in": course_ids}}).to_list(10000)
        by_course = {c["course_id"]: c for c in course_docs}

        sched_docs = []
        if by_section:
            sched_docs = await db.section_schedules.find(
                {"section_id": {"$in": list(by_section.keys())}}
            ).to_list(100000)
        by_sched: Dict[str, List[dict]] = {}
        for sc in sched_docs:
            by_sched.setdefault(sc["section_id"], []).append(sc)

        room_ids = list({s.get("room_id") for s in sched_docs if s.get("room_id")})
        room_docs = []
        if room_ids:
            room_docs = await db.rooms.find({"room_id": {"$in": room_ids}}).to_list(10000)
        by_room = {r["room_id"]: r for r in room_docs}

        faculty_ids = list({a.get("faculty_id") for a in asg_docs if a.get("faculty_id")})
        fprof_docs = []
        if faculty_ids:
            fprof_docs = await db.faculty_profiles.find({"faculty_id": {"$in": faculty_ids}}).to_list(10000)
        by_fprof = {f["faculty_id"]: f for f in fprof_docs}

        user_ids = list({f.get("user_id") for f in fprof_docs if f.get("user_id")})
        user_docs = []
        if user_ids:
            user_docs = await db.users.find({"user_id": {"$in": user_ids}}).to_list(10000)
        by_user = {u["user_id"]: u for u in user_docs}

        leave_docs = []
        if faculty_ids:
            leave_docs = await db.leaves.find({"faculty_id": {"$in": faculty_ids}}).to_list(10000)
        on_leave_now = {lv["faculty_id"] for lv in leave_docs if lv.get("is_active")}

        rows: List[PlantillaRow] = []

        for asg in asg_docs:
            sec = by_section.get(asg.get("section_id") or "")
            if not sec:
                continue

            course = by_course.get(sec.get("course_id") or "")
            fprof = by_fprof.get(asg.get("faculty_id") or "")
            user = by_user.get(fprof.get("user_id") if fprof else "")

            if user:
                last = str(user.get("last_name") or "").strip().upper()
                first = str(user.get("first_name") or "").strip()
                faculty_name = (f"{last}, {first}".strip() or "—")
            else:
                faculty_name = "—"

            scheds = by_sched.get(sec["section_id"], [])
            day_parts, time_parts, room_parts = [], [], []
            
            for sc in scheds[:2]:
                day_parts.append(str(sc.get("day") or ""))
                time_parts.append(_fmt_time(str(sc.get("start_time") or ""), str(sc.get("end_time") or "")))
                
                # --- [UPDATED] Room Logic ---
                # Goal: Show room_number if assigned.
                # If room_id is null/invalid, show "TBA" (unless it is explicitly ONLINE).
                # Do NOT show generic room types like "Classroom".

                room_id = sc.get("room_id")
                if room_id:
                    r = by_room.get(room_id)
                    if r:
                        # Found the room -> show Room Number (fallback to TBA if number missing)
                        r_num = r.get("room_number")
                        room_parts.append(str(r_num) if r_num else "TBA")
                    else:
                        # ID exists but room doc missing -> TBA
                        room_parts.append("TBA")
                else:
                    # No Room ID assigned. 
                    # If type is "ONLINE", we show "ONLINE".
                    # Otherwise (Classroom, Comlab, null) -> "TBA".
                    val = str(sc.get("room_type") or "").strip().upper()
                    if val == "ONLINE":
                        room_parts.append("ONLINE")
                    else:
                        room_parts.append("TBA")

            day_text = " / ".join([p for p in day_parts if p]) or "—"
            time_text = " / ".join([p for p in time_parts if p]) or "—"
            room_text = " / ".join([p for p in room_parts if p]) or "—"

            student_count = sec.get("enrolled") or None

            units = course.get("units") if course else None
            if units == 3:
                lec_hours = 1.5
                lab_hours = 1.5
            else:
                lec_hours = None
                lab_hours = None

            course_type = course.get("type_of_course") if course else "N/A"

            nature_teaching = float(units) if isinstance(units, (int, float)) else None
            nature_admin = 0.0
            nature_research = 0.0
            nature_faculty_units = (nature_teaching or 0.0) + nature_admin + nature_research

            premium_grad = 3.0 if (course_type and str(course_type).lower() == "grad") else 0.0
            premium_4th_prep = 0.0
            premium_overload = 0.0

            on_leave = "Yes" if asg.get("faculty_id") in on_leave_now else "N/A"

            if course:
                if isinstance(course.get("course_code"), list) and course["course_code"]:
                    course_code = str(course["course_code"][0])
                else:
                    course_code = str(course.get("course_code") or "—")
            else:
                course_code = "—"

            rows.append(
                PlantillaRow(
                    faculty_name=faculty_name,
                    course_code=course_code,
                    section_code=sec.get("section_code") or "—",
                    day_text=day_text,
                    time_text=time_text,
                    room_text=room_text,
                    student_count=student_count,
                    lec_hours=lec_hours,
                    lab_hours=lab_hours,
                    student_units=float(units) if isinstance(units, (int, float)) else None,
                    on_leave=on_leave,
                    course_type=course_type or "N/A",
                    nature_teaching=nature_teaching,
                    nature_admin=nature_admin,
                    nature_research=nature_research,
                    nature_faculty_units=nature_faculty_units,
                    premium_grad=premium_grad,
                    premium_4th_prep=premium_4th_prep,
                    premium_overload=premium_overload,
                    remarks="—",
                ).dict()
            )

        rows.sort(key=lambda r: (r.get("faculty_name", ""), r.get("course_code", "")))
        return {"ok": True, "rows": rows}

    return {"ok": False, "error": f"Unknown action '{action}'"}


@router.post("/plantilla")
async def chair_plantilla_post(
    userId: Optional[str] = Query(None),
    action: str = Query("approve")
) -> Dict[str, Any]:
    """
    POST /api/chair/plantilla?action=approve
    """
    if action == "approve":
        now = datetime.now(timezone.utc).isoformat()
        await db.plantilla_reviews.insert_one({
            "review_id": f"RVW-{int(datetime.now().timestamp())}",
            "plantilla_id": "PLT_DEV",
            "reviewer_id": userId or "UNKNOWN",
            "reviewer_role": "ROLE0002",
            "action": "approved",
            "comments": "Approved via UI",
            "review_date": now,
        })
        return {"ok": True}

    return {"ok": False, "error": f"Unknown action '{action}'"}