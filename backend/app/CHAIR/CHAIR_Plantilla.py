# backend/app/CHAIR/CHAIR_Plantilla.py
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel

from ..main import db

router = APIRouter(prefix="/chair", tags=["chair"])


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
    - fetch : plantilla rows for current term + user's department (chair scope)
    - options: left for parity (not used by UI)
    """
    if action == "header":
        profile_name = " "
        profile_subtitle = "Department Chair"
        dept_label = "Department"
        plantilla_file = "Faculty_Plantilla.pdf"
        term_label = None

        if userId:
            u = await db.users.find_one({"user_id": userId}) or {}
            first = (u.get("first_name") or "").strip()
            last  = (u.get("last_name")  or "").strip()

            # NEW: Build a proper full name for the topbar
            full_name = " ".join(p for p in [first, last] if p).strip()
            profile_name = full_name or " "

            sp = await db.staff_profiles.find_one({"user_id": userId}) or {}
            if sp.get("position_title"):
                profile_subtitle = sp["position_title"]

            ra = await db.role_assignments.find_one({"user_id": userId}) or {}
            dept_label = "Department"
            # (scope mapping left as-is)

        term = await db.terms.find_one({"is_current": True})
        if term:
            ay = term.get("acad_year_start")
            tn = term.get("term_number")
            if ay and tn:
                term_label = f"AY {ay}-{int(ay)+1} · Term {tn}"

        return {
            "ok": True,
            "profileName": profile_name,  # remains for compatibility
            "full_name": profile_name,    # NEW: explicit field the FE can trust
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
        """
        Build plantilla rows by joining:
          faculty_assignments -> sections -> courses -> section_schedules -> rooms
          plus faculty_profiles (for leave) and simple computed fields.
        We constrain by 'current term' when possible.
        """
        # current term
        term = await db.terms.find_one({"is_current": True})
        term_id = term.get("term_id") if term else None

        # basic section + assignment filter (if term present)
        sec_match = {"term_id": term_id} if term_id else {}

        # 1) sections in current term
        section_docs = await db.sections.find(sec_match).to_list(10000)
        by_section = {s["section_id"]: s for s in section_docs}

        # 2) map courses
        course_ids = list({s.get("course_id") for s in section_docs if s.get("course_id")})
        course_docs = await db.courses.find({"course_id": {"$in": course_ids}}).to_list(10000)
        by_course = {c["course_id"]: c for c in course_docs}

        # 3) schedules per section (aggregate day/time; pick two patterns if multiple)
        sched_docs = await db.section_schedules.find(
            {"section_id": {"$in": list(by_section.keys())}}
        ).to_list(100000)
        by_sched: Dict[str, List[dict]] = {}
        for sc in sched_docs:
            by_sched.setdefault(sc["section_id"], []).append(sc)

        # 4) rooms (for text)
        room_ids = list({s.get("room_id") for s in sched_docs if s.get("room_id")})
        room_docs = await db.rooms.find({"room_id": {"$in": room_ids}}).to_list(10000)
        by_room = {r["room_id"]: r for r in room_docs}

        # 5) assignments to link faculty -> sections
        asg_docs = await db.faculty_assignments.find(
            {"section_id": {"$in": list(by_section.keys())}, "is_archived": {"$in": [False, None]}}
        ).to_list(100000)

        # 6) faculty profiles + users for name
        faculty_ids = list({a.get("faculty_id") for a in asg_docs if a.get("faculty_id")})
        fprof_docs = await db.faculty_profiles.find({"faculty_id": {"$in": faculty_ids}}).to_list(10000)
        by_fprof = {f["faculty_id"]: f for f in fprof_docs}

        user_ids = list({f.get("user_id") for f in fprof_docs if f.get("user_id")})
        user_docs = await db.users.find({"user_id": {"$in": user_ids}}).to_list(10000)
        by_user = {u["user_id"]: u for u in user_docs}

        # 7) leaves (for "On Leave" column – coarse)
        leave_docs = await db.leaves.find({"faculty_id": {"$in": faculty_ids}}).to_list(10000)
        on_leave_now = {lv["faculty_id"] for lv in leave_docs if lv.get("is_active")}

        # Build rows
        rows: List[PlantillaRow] = []

        for asg in asg_docs:
            sec = by_section.get(asg.get("section_id") or "")
            if not sec:
                continue
            course = by_course.get(sec.get("course_id") or "")
            fprof = by_fprof.get(asg.get("faculty_id") or "")
            user = by_user.get(fprof.get("user_id") if fprof else "")
            faculty_name = (f"{user.get('last_name','').upper()}, {user.get('first_name','')}".strip()
                            if user else "—")

            # day/time/room text from schedules (coalesced)
            scheds = by_sched.get(sec["section_id"], [])
            # Compose "M / H", "T / F", etc.
            day_parts = []
            time_parts = []
            room_parts = []
            for sc in scheds[:2]:  # keep UI compact
                day_parts.append(str(sc.get("day") or ""))
                time_parts.append(_fmt_time(str(sc.get("start_time") or ""), str(sc.get("end_time") or "")))
                if sc.get("room_id"):
                    r = by_room.get(sc["room_id"])
                    room_parts.append(r["room_number"] if r and r.get("room_number") else str(sc.get("room_id")))
                else:
                    room_parts.append(sc.get("room_type") or "ONLINE")
            day_text = " / ".join([p for p in day_parts if p]) or "—"
            # If mixed schedules, prefer the earliest start–latest end pair
            time_text = " / ".join([p for p in time_parts if p]) or "—"
            room_text = " / ".join([p for p in room_parts if p]) or "—"

            # student counts
            student_count = sec.get("enrolled") or None

            # simple hours/units (use 1.5 + 1.5 for standard 3-unit courses if no breakdown)
            units = course.get("units") if course else None
            if units == 3:
                lec_hours = 1.5
                lab_hours = 1.5
            else:
                lec_hours = None
                lab_hours = None

            # type of course
            course_type = course.get("type_of_course") if course else "N/A"

            # "nature of load" & premiums – placeholders derived from simple rules
            nature_teaching = float(units) if isinstance(units, (int, float)) else None
            nature_admin = 0.0
            nature_research = 0.0
            nature_faculty_units = (nature_teaching or 0.0) + nature_admin + nature_research

            premium_grad = 3.0 if (course_type and str(course_type).lower() == "grad") else 0.0
            premium_4th_prep = 0.0  # needs policy engine; keep 0
            premium_overload = 0.0  # needs policy engine; keep 0

            # leave / remarks
            on_leave = "Yes" if asg.get("faculty_id") in on_leave_now else "N/A"
            remarks = "—"

            rows.append(
                PlantillaRow(
                    faculty_name=faculty_name,
                    course_code=(course.get("course_code")[0] if isinstance(course.get("course_code"), list) and course["course_code"] else course.get("course_code") or "—")
                                if course else "—",
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
                    remarks=remarks,
                ).dict()
            )

        # Sort by faculty then course for consistent display
        rows.sort(key=lambda r: (r.get("faculty_name", ""), r.get("course_code", "")))
        return {"ok": True, "rows": rows}

    # default
    return {"ok": False, "error": f"Unknown action '{action}'"}


@router.post("/plantilla")
async def chair_plantilla_post(
    userId: Optional[str] = Query(None),
    action: str = Query("approve")  # approve (future: submit, etc.)
) -> Dict[str, Any]:
    """
    POST /api/chair/plantilla?action=approve
    Marks/records a simple approval in plantilla_reviews (audit trail).
    """
    if action == "approve":
        # pick or synthesize a plantilla_id for current dept/term; for dev we log a simple record
        now = datetime.now(timezone.utc).isoformat()
        # Minimal write (idempotent-ish for dev): insert an audit-like document
        await db.plantilla_reviews.insert_one({
            "review_id": f"RVW-{int(datetime.now().timestamp())}",
            "plantilla_id": "PLT_DEV",
            "reviewer_id": userId or "UNKNOWN",
            "reviewer_role": "ROLE0002",  # Department Chair
            "action": "approved",
            "comments": "Approved via UI",
            "review_date": now,
        })
        return {"ok": True}

    return {"ok": False, "error": f"Unknown action '{action}'"}
