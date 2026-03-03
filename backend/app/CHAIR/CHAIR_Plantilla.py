# backend/app/CHAIR/CHAIR_Plantilla.py
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set

from fastapi import APIRouter, Query
from pydantic import BaseModel

from ..main import db

router = APIRouter(prefix="/chair", tags=["chair"])

# ---------- Collections ----------
COL_TERMS = "terms"
COL_PREEN_COUNT = "preenlistment_count"
COL_FACULTY_LOADS = "faculty_loads"
COL_SPECIAL = "special_class"


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
    # Distinguish rows that originate from OM_SpecialClass reflections.
    source: Optional[str] = None  # e.g., "SPECIALCLASS"
    source_id: Optional[str] = None  # e.g., special_id


def _fmt_time(start: str, end: str) -> str:
    """Format times into a consistent display form.

    Times can come from different sources:
    - OM schedules often store compact digits like "730" / "1445".
    - Faculty Service approvals store "HH:MM" strings like "07:30".

    Plantilla should render both correctly.
    """

    def to_hhmm(t: str) -> Optional[str]:
        t = (t or "").strip()

        if not t:
            return None

        # Accept "HH:MM" (Faculty Service)
        if ":" in t:
            hh, mm = (p.strip() for p in t.split(":", 1))
            if not (hh.isdigit() and mm.isdigit() and len(mm) == 2):
                return None
            try:
                h = int(hh)
                m = int(mm)
            except ValueError:
                return None
            if h < 0 or h > 23 or m < 0 or m > 59:
                return None
            return f"{h}:{str(m).zfill(2)}"

        # Accept compact digits like "730" / "1445" (OM)
        if not t.isdigit():
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
        if h < 0 or h > 23 or m < 0 or m > 59:
            return None
        return f"{h}:{str(m).zfill(2)}"

    b = to_hhmm(start)
    e = to_hhmm(end)
    if b and e:
        return f"{b}–{e}"
    return b or e or "—"

def _norm_scope_list(scope_val: Any) -> List[Dict[str, Any]]:
    """role_assignments.scope can be dict | list[dict] | missing."""
    if not scope_val:
        return []
    if isinstance(scope_val, dict):
        return [scope_val]
    if isinstance(scope_val, list):
        return [s for s in scope_val if isinstance(s, dict)]
    return []


def _is_dissolved_remarks(val: Any) -> bool:
    """Return True if a remarks-like value contains a DISSOLVED marker.

    Context:
    - OM_ClassRetention / CHAIR_ClassRetention persist the class retention status "Dissolved"
      as a marker in `sections.remarks` (e.g., "... | DISSOLVED").
    - OM_LoadAssignment and APO_CourseOfferings display this marker.
    - CHAIR_Plantilla should *exclude* dissolved classes from plantilla output.
    """
    if val is None:
        return False
    try:
        s = str(val)
    except Exception:
        return False
    return "dissolved" in s.lower()


async def _dept_id_for_user(user_id: str) -> Optional[str]:
    """
    Resolve department_id for a user.

    IMPORTANT: OM screens rely on role_assignments.scope (type=department) for dept scoping.
    Chair should mirror that behavior so the same users show their department in the TopBar
    and data fetches scope correctly.
    """
    if not user_id:
        return None

    # 1) staff_profiles
    sp = await db.staff_profiles.find_one({"user_id": user_id}) or {}
    dept_id = sp.get("department_id") or sp.get("dept_id")
    if dept_id:
        return str(dept_id).strip()

    # 2) role_assignments (direct fields + scope)
    ra_docs = await db.role_assignments.find(
        {"user_id": user_id, "is_active": {"$in": [True, None]}},
        {"_id": 0, "department_id": 1, "dept_id": 1, "scope": 1, "updated_at": 1, "created_at": 1, "role_assignment_id": 1},
    ).sort([("updated_at", -1), ("created_at", -1), ("role_assignment_id", -1)]).to_list(10)

    # 2a) direct department_id/dept_id
    for row in ra_docs or []:
        cand = row.get("department_id") or row.get("dept_id")
        if cand:
            return str(cand).strip()

    # 2b) scoped departments (OM-style)
    for row in ra_docs or []:
        for s in _norm_scope_list(row.get("scope")):
            stype = str(s.get("type") or "").strip().lower()
            if stype != "department":
                continue
            cand = s.get("id") or s.get("department_id") or s.get("dept_id")
            if cand:
                return str(cand).strip()

    # 3) faculty_profiles fallback
    fp = await db.faculty_profiles.find_one({"user_id": user_id}) or {}
    dept_id = fp.get("department_id") or fp.get("dept_id")
    if dept_id:
        return str(dept_id).strip()

    return None


# ---------------- Department name helpers ----------------

async def _dept_names_for_ids(dept_ids: List[str]) -> List[str]:
    """Resolve department names for a list of department ids.

    Faculty Service stores `to_department` / `from_department` as *department names* (dept_name).
    Chair/OM role scoping often provides *department ids* (e.g., DEPT0001).

    This helper returns a de-duplicated list of department names for the provided ids.
    If the departments collection isn't available or a given id isn't found, it skips it.
    """
    ids = [str(x).strip() for x in (dept_ids or []) if str(x).strip()]
    if not ids:
        return []

    try:
        cur = db.departments.find(
            {"department_id": {"$in": ids}},
            {"_id": 0, "department_id": 1, "dept_name": 1},
        )
        rows = [d async for d in cur]
        names = [str(r.get("dept_name") or "").strip() for r in rows if str(r.get("dept_name") or "").strip()]
        # de-dup preserving order
        out: List[str] = []
        seen: Set[str] = set()
        for n in names:
            if n not in seen:
                seen.add(n)
                out.append(n)
        return out
    except Exception:
        return []

def _looks_like_dept_id(v: str) -> bool:
    s = (v or "").strip()
    return bool(s) and s.upper().startswith("DEPT")

async def _dept_name_candidates_for_scope(dept_candidates: List[str]) -> List[str]:
    """Return candidates to match Faculty Service `to_department` values.

    Includes:
      - Resolved dept_name for any DEPT* ids in dept_candidates (via departments collection)
      - Any non-empty strings in dept_candidates (in case they are already names)
    """
    cands = [str(x).strip() for x in (dept_candidates or []) if str(x).strip()]
    ids = [c for c in cands if _looks_like_dept_id(c)]
    names = await _dept_names_for_ids(ids) if ids else []
    merged = list(names) + cands

    out: List[str] = []
    seen: Set[str] = set()
    for x in merged:
        if not x:
            continue
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


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
            dept_id = await _dept_id_for_user(userId)

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
            d = (
                await db.departments.find_one({"department_id": dept_id})
                or await db.departments.find_one({"dept_id": dept_id})
                or await db.departments.find_one({"id": dept_id})
                or {}
            )
            dept_name = (d.get("dept_name") or d.get("department_name") or d.get("name") or "").strip() or None

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
            {"label": "Load Assignment", "to": "/chair/load-assignment"},
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

        # --- NEW: show plantilla only after OM forwards (faculty_loads header exists) ---
        if not term_id:
            return {"ok": True, "rows": []}

        dept_id: Optional[str] = None
        if userId:
            sp = await db.staff_profiles.find_one({"user_id": userId}) or {}
            dept_id = await _dept_id_for_user(userId)

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

        dept_candidates = ["DEPT0001"]  # keep existing behavior used by OM forward
        if dept_id and dept_id not in dept_candidates:
            dept_candidates.insert(0, dept_id)

        forwarded = await db[COL_FACULTY_LOADS].find_one(
            {
                "term_id": term_id,
                "department_id": {"$in": dept_candidates},
                "forwarded_to_chair": True,   # <-- NEW requirement
            },
            {"_id": 1, "load_id": 1, "forwarded_section_ids": 1},
        )
        allowed_section_ids = [
            str(x).strip()
            for x in (((forwarded or {}).get("forwarded_section_ids")) or [])
            if str(x).strip()
        ]
        allowed_set: Set[str] = set(allowed_section_ids)

        # OM_SpecialClass reflections are separate from OM load assignments.
        # Approved special_class rows must be visible even when OM hasn't forwarded the plantilla.
        special_docs = await db[COL_SPECIAL].find(
            {
                "term_id": term_id,
                "status": "Approved",
                "$or": [
                    {"department_id": {"$in": dept_candidates}},
                    {"dept_id": {"$in": dept_candidates}},
                    {"departmentId": {"$in": dept_candidates}},
                ],
            },
            {"_id": 0, "special_id": 1, "section_id": 1},
        ).to_list(5000)

        special_section_ids = [str(d.get("section_id") or "").strip() for d in (special_docs or [])]
        special_section_ids = [s for s in special_section_ids if s]

        # Faculty Service (accepted/approved) rows must be visible even when OM hasn't forwarded the plantilla.
        # These are the "serviced classes" that were accepted via CHAIR_FacultyService (status = responded).
        #
        # IMPORTANT:
        # Plantilla rows are primarily built from `faculty_assignments` + `section_schedules`.
        # In some deployments, the "sync-to-OM" mirror from Faculty Service is best-effort and
        # may fail (e.g., missing active term mapping). When that happens, the approved service
        # class would *not* appear in Plantilla even though it is approved.
        #
        # To guarantee correct visibility, we pull the approved faculty_service details and
        # use them as a fallback to synthesize the assignment + schedule info in-memory.
        # Faculty Service stores canonical department NAMES (not ids). Build name candidates for matching.
        dept_name_candidates: List[str] = await _dept_name_candidates_for_scope(dept_candidates)
        # Track latest Faculty Service status per section so we can exclude unapproved serviced classes
        # from plantilla even if OM forwarded them.
        fs_status_by_section: Dict[str, str] = {}

        fs_by_section: Dict[str, str] = {}
        fs_section_ids: List[str] = []
        fs_detail_by_section: Dict[str, Dict[str, Any]] = {}
        try:
            # pull latest status per section for this receiving department
            fs_any_docs = await db.faculty_service.find(
                {
                    "section_id": {"$exists": True, "$ne": None},
                    "to_department": {"$in": (dept_name_candidates or dept_candidates)},
                },
                {"_id": 0, "section_id": 1, "status": 1},
            ).to_list(5000)
            for d in (fs_any_docs or []):
                sid = str(d.get("section_id") or "").strip()
                if not sid:
                    continue
                st = str(d.get("status") or "").strip()
                # If multiple rows exist for the same section, prefer the most "committed" status.
                # responded > rejected > sent
                prev = fs_status_by_section.get(sid) or ""
                rank = {"sent": 1, "rejected": 2, "responded": 3}
                if rank.get(st, 0) >= rank.get(prev, 0):
                    fs_status_by_section[sid] = st

            fs_docs = await db.faculty_service.find(
                {
                    "status": "responded",
                    "section_id": {"$exists": True, "$ne": None},
                    "to_department": {"$in": (dept_name_candidates or dept_candidates)},
                },
                {
                    "_id": 0,
                    "fs_id": 1,
                    "section_id": 1,
                    "faculty": 1,
                    "day1": 1,
                    "begin1": 1,
                    "end1": 1,
                    "day2": 1,
                    "begin2": 1,
                    "end2": 1,
                    "remarks": 1,
                },
            ).to_list(5000)

            for d in (fs_docs or []):
                sid = str(d.get("section_id") or "").strip()
                fsid = str(d.get("fs_id") or "").strip()
                if not sid:
                    continue
                fs_by_section[sid] = fsid
                fs_detail_by_section[sid] = d

            fs_section_ids = [sid for sid in fs_by_section.keys() if sid]
        except Exception:
            fs_by_section = {}
            fs_section_ids = []
            fs_detail_by_section = {}

        # If neither forwarded rows nor approved SpecialClass rows exist, return empty.
        if not forwarded and not special_section_ids and not fs_section_ids:
            return {"ok": True, "rows": []}

        # Sections for that term.
        # If OM forwarded a snapshot, restrict to that set.
        # Always include approved SpecialClass sections (mirror rows).
        sec_match: Dict[str, Any] = {"term_id": term_id} if term_id else {}
        combined_section_ids: Set[str] = set(allowed_set)
        combined_section_ids.update(special_section_ids)
        combined_section_ids.update(fs_section_ids)
        # If a section is a serviced class (has a faculty_service row) but is NOT approved/responded,
        # it must not appear in Plantilla even if OM forwarded it.
        if fs_status_by_section:
            for sid, st in fs_status_by_section.items():
                if sid and (st != "responded") and (sid in combined_section_ids) and (sid not in set(special_section_ids)):
                    combined_section_ids.discard(sid)
        if combined_section_ids:
            sec_match = {**sec_match, "section_id": {"$in": list(combined_section_ids)}}
        section_docs = await db.sections.find(sec_match).to_list(10000)

        # Exclude dissolved classes from plantilla.
        # Dissolved status is stored as a marker in `sections.remarks`.
        dissolved_section_ids: Set[str] = set()
        if section_docs:
            filtered_sections: List[dict] = []
            for s in section_docs:
                if _is_dissolved_remarks(s.get("remarks")):
                    sid = str(s.get("section_id") or "").strip()
                    if sid:
                        dissolved_section_ids.add(sid)
                    continue
                filtered_sections.append(s)
            section_docs = filtered_sections
        

        # Fallback: If no sections, try to guess from assignments
        asg_docs: List[dict] = []
        if not section_docs:
            asg_filter = {"is_archived": {"$in": [False, None]}}
            if combined_section_ids:
                asg_filter = {**asg_filter, "section_id": {"$in": list(combined_section_ids)}}
            asg_docs = await db.faculty_assignments.find(asg_filter).to_list(100000)

            sec_ids = list({a.get("section_id") for a in asg_docs if a.get("section_id")})
            if sec_ids:
                section_docs = await db.sections.find({"section_id": {"$in": sec_ids}}).to_list(10000)

                # Exclude dissolved classes from plantilla.
                filtered_sections: List[dict] = []
                for s in section_docs:
                    if _is_dissolved_remarks(s.get("remarks")):
                        sid = str(s.get("section_id") or "").strip()
                        if sid:
                            dissolved_section_ids.add(sid)
                        continue
                    filtered_sections.append(s)
                section_docs = filtered_sections
        
        if not asg_docs and section_docs:
            asg_docs = await db.faculty_assignments.find(
                {"section_id": {"$in": [s.get("section_id") for s in section_docs]},
                 "is_archived": {"$in": [False, None]}}
            ).to_list(100000)

        # If we discovered dissolved sections, drop any assignments referencing them.
        if dissolved_section_ids and asg_docs:
            asg_docs = [a for a in asg_docs if str(a.get("section_id") or "").strip() not in dissolved_section_ids]

        # Ensure approved Faculty Service classes appear in Plantilla even if the
        # OM-sync mirror did not create faculty_assignments/section_schedules yet.
        # We synthesize (or fill) the assignment data using the faculty_service record.
        if fs_detail_by_section:
            try:
                # Index current assignments by section for quick checks
                asg_by_section = {}
                for a in (asg_docs or []):
                    sid = str(a.get('section_id') or '').strip()
                    if sid and sid not in asg_by_section:
                        asg_by_section[sid] = a

                for sid, fsd in fs_detail_by_section.items():
                    if dissolved_section_ids and sid in dissolved_section_ids:
                        continue

                    fac = fsd.get('faculty') or {}
                    fac_id = str((fac or {}).get('faculty_id') or '').strip()
                    if not fac_id:
                        continue

                    if sid in asg_by_section:
                        # Fill missing faculty_id (or keep existing)
                        if not str(asg_by_section[sid].get('faculty_id') or '').strip():
                            asg_by_section[sid]['faculty_id'] = fac_id
                    else:
                        # Create a minimal non-archived assignment placeholder
                        new_asg = {
                            'section_id': sid,
                            'faculty_id': fac_id,
                            'is_archived': False,
                            'synced_from_faculty_service': True,
                        }
                        asg_docs.append(new_asg)
                        asg_by_section[sid] = new_asg
            except Exception:
                # Best-effort only; do not break plantilla generation.
                pass

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

        # Faculty Service schedules should override section_schedules when a class is serviced/accepted.
        # Reason: the serviced class schedule is defined in the request (day1/day2 + begin/end) and may differ
        # from the originating section_schedules. Plantilla must reflect the approved request schedule.
        if fs_detail_by_section:
            try:
                for sid, fsd in fs_detail_by_section.items():
                    if sid not in by_section:
                        continue

                    d1 = str(fsd.get('day1') or '').strip()
                    b1 = str(fsd.get('begin1') or '').strip()
                    e1 = str(fsd.get('end1') or '').strip()
                    d2 = str(fsd.get('day2') or '').strip()
                    b2 = str(fsd.get('begin2') or '').strip()
                    e2 = str(fsd.get('end2') or '').strip()

                    synthetic = []
                    if d1 or b1 or e1:
                        synthetic.append({
                            'section_id': sid,
                            'schedule_id': f'FS-{sid}-01',
                            'day': d1 or None,
                            'start_time': b1 or None,
                            'end_time': e1 or None,
                            'room_type': 'TBA',
                        })
                    if d2 or b2 or e2:
                        synthetic.append({
                            'section_id': sid,
                            'schedule_id': f'FS-{sid}-02',
                            'day': d2 or None,
                            'start_time': b2 or None,
                            'end_time': e2 or None,
                            'room_type': 'TBA',
                        })

                    # Override any existing schedules for this section if Faculty Service provided schedule data.
                    if synthetic:
                        by_sched[sid] = synthetic
            except Exception:
                pass

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

        # Mark which sections came from SpecialClass so the UI can color them.
        special_by_section: Dict[str, str] = {}
        for d in (special_docs or []):
            sid = str(d.get("section_id") or "").strip()
            spid = str(d.get("special_id") or "").strip()
            if sid and spid:
                special_by_section[sid] = spid

        rows: List[PlantillaRow] = []

        for asg in asg_docs:
            sec = by_section.get(asg.get("section_id") or "")
            if not sec:
                continue

            sid = str(sec.get('section_id') or '').strip()
            is_special = sid in special_by_section
            is_fs = sid in fs_by_section
            fs_detail = fs_detail_by_section.get(sid) if fs_detail_by_section else None
            fs_remarks = str((fs_detail or {}).get('remarks') or '').strip()
            remarks_label = (
                'SPECIAL CLASS' if is_special else ('FACULTY SERVICE' if is_fs else '—')
            )
            if (not is_special) and is_fs and fs_remarks:
                remarks_label = f"FACULTY SERVICE - {fs_remarks}"

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
            # Sort schedules to ensure Day 1 (e.g., Mon) comes before Day 2 (e.g., Thu)
            # Assumes schedule_id ends in -01, -02 or simply by creation
            scheds.sort(key=lambda x: x.get("schedule_id", ""))

            day_parts, time_parts, room_parts = [], [], []
            
            for sc in scheds[:2]:
                # 1. Day & Time Logic
                day_parts.append(str(sc.get("day") or ""))
                time_parts.append(_fmt_time(str(sc.get("start_time") or ""), str(sc.get("end_time") or "")))
                
                # 2. Room Logic (Specific Request)
                raw_type = str(sc.get("room_type") or "").strip()
                room_id = sc.get("room_id")

                # IMPORTANT:
                # Some Special Class / APO flows may leave `room_type` as "Online" even after a
                # physical room has been allocated (room_id is populated). In those cases, we must
                # prefer the actual room_id over the room_type flag so CHAIR_Plantilla reflects
                # the same room assignment shown in OM_SpecialClass.
                #
                # Rule:
                # - If a room_id exists, display the room number (physical room).
                # - Else, if room_type is Online, display ONLINE.
                # - Else, TBA.

                if room_id:
                    r_obj = by_room.get(room_id)
                    if r_obj and r_obj.get("room_number"):
                        room_parts.append(str(r_obj["room_number"]))
                    else:
                        # room_id exists but not found in DB (or has no number)
                        room_parts.append("TBA")
                elif raw_type.lower() == "online":
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
                    remarks=remarks_label,
                    source=(
                        'SPECIALCLASS'
                        if is_special
                        else ('FACULTY_SERVICE' if is_fs else None)
                    ),
                    source_id=(
                        special_by_section.get(sid)
                        if is_special
                        else (fs_by_section.get(sid) if is_fs else None)
                    ),
                ).dict()
            )

        rows.sort(key=lambda r: (r.get("faculty_name", ""), r.get("course_code", "")))
        return {"ok": True, "rows": rows}

    return {"ok": False, "error": f"Unknown action '{action}'"}
