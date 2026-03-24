# backend/app/OM/OM_FacultyForm.py
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query
import re

from ..main import db
from ..Notifications import create_notification
from datetime import datetime, timezone, timedelta  # <-- add

router = APIRouter(prefix="/om", tags=["om"])

# ---- Collections (existing) ----
COL_USERS = "users"
COL_FACULTY = "faculty_profiles"
COL_DEPARTMENTS = "departments"
COL_TERMS = "terms"
COL_PREFS = "faculty_preferences"
COL_CAMPUSES = "campuses"
COL_KACS = "kacs"
COL_PREEN_COUNT = "preenlistment_count" 
COL_PREFS_WINDOWS = "faculty_prefs_windows"


async def _notify_all_faculty_deadline_changed(
    term_id: str,
    old_deadline_iso: str,
    new_deadline_iso: str,
    *,
    actor_user_id: str | None = None,
) -> None:
    """Notify all faculty (in-app bell) when OM changes the preferences deadline."""

    # Avoid noise if nothing actually changed.
    if (old_deadline_iso or "") == (new_deadline_iso or ""):
        return

    # Best-effort resolve a friendly term label.
    term_doc = await db[COL_TERMS].find_one(
        {"term_id": term_id},
        {"_id": 0, "acad_year_start": 1, "term_number": 1},
    ) or {}
    ay = term_doc.get("acad_year_start")
    tn = term_doc.get("term_number")
    term_label = (
        f"Term {tn} · AY {ay}-{ay + 1}" if (ay is not None and tn is not None) else term_id
    )

    def _fmt(iso: str) -> str:
        if not iso:
            return "—"
        try:
            dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
            # Display in local server timezone formatting (frontend can reformat if needed).
            return dt.astimezone(timezone.utc).strftime("%b %d, %Y %I:%M %p UTC")
        except Exception:
            return str(iso)

    title = "Preference Submission Deadline Updated"
    details = (
        f"The Office Manager updated the preference submission deadline for {term_label}. "
        f"New deadline: {_fmt(new_deadline_iso)}"
        + (f" (previously {_fmt(old_deadline_iso)})." if old_deadline_iso else ".")
    )

    # Target all faculty users (user_id stored in faculty_profiles).
    cursor = db[COL_FACULTY].find(
        {"user_id": {"$ne": None}},
        {"_id": 0, "user_id": 1, "faculty_id": 1},
    )
    faculty_docs = await cursor.to_list(length=None)

    # Best-effort: don't let a single failure block others.
    for f in faculty_docs:
        uid = (f.get("user_id") or "").strip()
        if not uid:
            continue
        try:
            await create_notification(
                user_id=uid,
                title=title,
                details=details,
                meta={
                    "route": "/faculty/preferences",
                    "kind": "prefs_deadline_changed",
                    "term_id": term_id,
                    "faculty_id": f.get("faculty_id"),
                    "old_deadline": old_deadline_iso or "",
                    "new_deadline": new_deadline_iso or "",
                },
                # Match APO behavior: every in-app notification also triggers a best-effort Gmail email.
                send_email=True,
                # Prefer sending via the OM's connected Gmail when available.
                email_from_user_id=(actor_user_id or None),
            )
        except Exception:
            # Notification is non-critical; ignore and continue.
            pass

# ---- Helpers (same style as Faculty Management) ----
def _dept_name_expr() -> Dict[str, Any]:
    return {"$ifNull": ["$dept.department_name", "$dept.dept_name"]}

def _full_name_expr() -> Dict[str, Any]:
    """Prefer joined users.{first,last}_name, fallback to faculty_profiles fields."""
    last = {"$ifNull": ["$u.last_name", "$last_name"]}
    first = {"$ifNull": ["$u.first_name", "$first_name"]}
    # Add comma only if both parts exist
    return {
        "$trim": {
            "input": {
                "$concat": [
                    {"$ifNull": [last, ""]},
                    {
                        "$cond": [
                            {"$and": [
                                {"$ne": [last, None]},
                                {"$ne": [first, None]},
                                {"$ne": [last, ""]},
                                {"$ne": [first, ""]},
                            ]},
                            ", ",
                            ""
                        ]
                    },
                    {"$ifNull": [first, ""]},
                ]
            }
        }
    }

def _faculty_type_display() -> Dict[str, Any]:
    """Map employment_type codes to human labels."""
    return {
        "$switch": {
            "branches": [
                {"case": {"$eq": ["$employment_type", "FT"]}, "then": "Full-Time"},
                {"case": {"$eq": ["$employment_type", "PT"]}, "then": "Part-Time"},
            ],
            "default": {"$ifNull": ["$employment_type", ""]},
        }
    }


# (new) parse date like in FACULTY_Preferences backend
def _parse_date_any(dt):
    if isinstance(dt, datetime):
        return dt
    if not dt:
        return None
    try:
        return datetime.fromisoformat(str(dt).replace("Z", "+00:00"))
    except Exception:
        return None


def _ensure_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

# (new) compute open/deadline like FACULTY_Preferences
def _prefs_window_from_term(term: Dict[str, Any]) -> tuple[datetime, datetime]:
    start = _parse_date_any(term.get("classes_start_date")) or _parse_date_any(term.get("start_date")) or datetime.now(timezone.utc)
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    open_dt = start + timedelta(weeks=6)   # Week 7
    close_dt = open_dt + timedelta(days=30)
    return open_dt, close_dt

# make sure this exists near your other COL_* constants:
COL_PREEN_COUNT = "preenlistment_count"


async def _active_term():
    """
    Return the WORKING / PLANNING term for OM Faculty Preferences.

    Priority:
    1) If there is an active (non-archived) pre-enlistment batch in
       preenlistment_count, use that term_id.
    2) Otherwise, use the *next* term after the current term
       (where is_current = True or status = 'active').
    3) If there is no "next" term configured, fall back to the current term
       (or latest AY/term_number if nothing is flagged current/active).

    Always returns fields needed for window calculation:
      term_id, acad_year_start, term_number, submission_deadline,
      start_date, classes_start_date
    """

    term_fields = {
        "_id": 0,
        "term_id": 1,
        "acad_year_start": 1,
        "term_number": 1,
        "submission_deadline": 1,
        "start_date": 1,
        "classes_start_date": 1,
    }

    # 1) Try to derive from an active pre-enlistment batch
    pre_doc = await db[COL_PREEN_COUNT].find_one(
        {"is_archived": {"$ne": True}},
        {"_id": 0, "term_id": 1},
    )
    if pre_doc and pre_doc.get("term_id"):
        t = await db[COL_TERMS].find_one(
            {"term_id": pre_doc["term_id"]},
            term_fields,
        )
        if t:
            return t

    # 2) Fallback: current term (status = active OR is_current = True)
    current = await db[COL_TERMS].find_one(
        {"$or": [{"status": "active"}, {"is_current": True}]},
        term_fields,
    )

    if not current:
        # Latest term by AY + term_number
        last = await db[COL_TERMS].find({}, term_fields) \
            .sort([("acad_year_start", -1), ("term_number", -1)]) \
            .limit(1).to_list(1)
        current = last[0] if last else None

    if not current:
        # No terms configured at all
        return {}

    # 3) Compute the "next" term after the current term
    # Prefer chronological ordering by (acad_year_start, term_number) as defined in the terms table.
    # If those fields are missing/inconsistent, fall back to numeric ordering from term_id (e.g., TERM0013 -> 13).
    next_term: Optional[dict] = None

    if current.get("acad_year_start") is not None and current.get("term_number") is not None:
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
            term_fields,
        ).sort([("acad_year_start", 1), ("term_number", 1)]).limit(1).to_list(1)

        if next_terms:
            next_term = next_terms[0]

    if not next_term:
        # Fallback: parse numeric suffix from TERM IDs and pick the smallest greater-than-current.
        def _term_id_num(tid: Optional[str]) -> Optional[int]:
            if not tid:
                return None
            m = re.search(r"(\d+)$", str(tid))
            return int(m.group(1)) if m else None

        cur_num = _term_id_num(current.get("term_id"))
        if cur_num is not None:
            # Pull only term_id (and minimal display fields) to keep this lightweight.
            candidates = await db[COL_TERMS].find(
                {"term_id": {"$type": "string"}},
                {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1, "submission_deadline": 1, "start_date": 1, "classes_start_date": 1},
            ).to_list(None)

            best = None
            best_num = None
            for t in candidates:
                n = _term_id_num(t.get("term_id"))
                if n is None or n <= cur_num:
                    continue
                if best_num is None or n < best_num:
                    best_num = n
                    best = t

            if best:
                # Ensure we include the same field set as term_fields
                # (best already includes all those keys, but keep consistent with callers)
                next_term = {k: best.get(k) for k in term_fields.keys() if k != "_id"}

    if next_term:
        # Use the next term as the working/planning term (e.g., if TERM0013 is current, TERM0014 is planning)
        return next_term

    # If no next term, stick with current (still better than returning nothing)
    return current


# ---------- Pretty-format helpers (OM-side only) ----------
DAY_LETTER_TO_NAME = {"M": "Monday", "T": "Tuesday", "W": "Wednesday", "H": "Thursday", "F": "Friday", "S": "Saturday"}
DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

def _expand_day_groups(groups: Optional[List[str]]) -> List[str]:
    """
    Faculty submit stores compressed groups like ["MW","H"].
    OM should show full names as a sorted unique list.
    """
    if not groups:
        return []
    expanded: List[str] = []
    for g in groups:
        for ch in str(g):
            nm = DAY_LETTER_TO_NAME.get(ch)
            if nm:
                expanded.append(nm)
    # unique in weekday order
    out: List[str] = []
    for d in DAY_ORDER:
        if d in expanded and d not in out:
            out.append(d)
    return out

def _fmt_time_range(s: str) -> str:
    """
    0915-1045  ->  09:15 - 10:45
    """
    m = re.match(r"^(\d{3,4})-(\d{3,4})$", s or "")
    if not m:
        return s
    def hhmm(x: str) -> str:
        x = x.zfill(4)
        return f"{x[:2]}:{x[2:]}"
    return f"{hhmm(m.group(1))} - {hhmm(m.group(2))}"

async def _mode_label(mode: Any) -> str:
    """
    Convert stored mode object into a nice label for OM:
      {"mode":"FOL", "campus_id":[...]} -> "Fully Online"
      {"mode":"HYB", "campus_id":["CMPS0001"]} -> "Hybrid — Manila"
      {"mode":"HYB", "campus_id":["CMPS0002"]} -> "Hybrid — Laguna"
      both -> "Hybrid — Manila, Laguna"
    """
    if not isinstance(mode, dict):
        # already a string label or empty
        return str(mode) if mode else "—"

    code = str(mode.get("mode") or "").upper()
    campus_ids = mode.get("campus_id") or []
    if code == "FOL":
        return "Fully Online"

    names: List[str] = []
    if campus_ids:
        cursor = db[COL_CAMPUSES].find(
            {"campus_id": {"$in": campus_ids}},
            {"_id": 0, "campus_id": 1, "campus_name": 1},
        )
        found = {c["campus_id"]: c.get("campus_name") for c in await cursor.to_list(length=10)}
        # preserve submitted order
        for cid in campus_ids:
            nm = found.get(cid)
            if nm:
                names.append(nm)

    if code == "HYB":
        label = "Hybrid"
        if names:
            label += " — " + ", ".join(names)
        return label

    return code or "—"

async def _kac_strings(raw: Any) -> List[str]:
    """
    Convert preferred_kacs into a string array (names/codes) for OM display.
    Accepts: list[str] | list[object] | None
    """
    if not raw:
        return []
    out: List[str] = []
    string_ids: List[str] = []
    for item in raw:
        if isinstance(item, dict):
            out.append(item.get("kac_name") or item.get("kac_code") or item.get("kac_id") or "")
        else:
            s = str(item).strip()
            if s:
                string_ids.append(s)

    if string_ids:
        cur = db[COL_KACS].find(
            {"kac_id": {"$in": string_ids}},
            {"_id": 0, "kac_id": 1, "kac_name": 1, "kac_code": 1},
        )
        found = {k["kac_id"]: k for k in await cur.to_list(length=200)}
        for sid in string_ids:
            k = found.get(sid)
            if not k:
                out.append(sid)
            else:
                out.append(k.get("kac_name") or k.get("kac_code") or sid)

    # clean empties
    return [x for x in out if x]

def _deload_strings(raw: Any) -> List[str]:
    """
    Convert [{deloading_type, units}] -> ["Administrative — 3 units", ...]
    """
    if not isinstance(raw, list):
        return []
    out: List[str] = []
    for r in raw:
        if not isinstance(r, dict):
            continue
        t = (r.get("deloading_type") or "").strip()
        u = r.get("units", 0)
        try:
            u = float(u)
        except Exception:
            u = 0
        if t:
            out.append(f"{t} — {u:g} units")
    return out

async def _prefs_window_override_for_term(term: Dict[str, Any]) -> Dict[str, Any]:
    """
    For OM UI: show ONLY manually-started windows.

    If OM has never clicked “Start Window”, this returns empty ISO strings
    so the UI can show 'Window not started'.
    """
    term = term or {}
    term_id = term.get("term_id")
    if not term_id:
        return {"openISO": "", "deadlineISO": "", "term_id": None}

    override = await db[COL_PREFS_WINDOWS].find_one(
        {"term_id": term_id},
        {"_id": 0, "open_dt": 1, "deadline_dt": 1, "openISO": 1, "deadlineISO": 1, "term_id": 1},
    )

    if not override:
        return {"openISO": "", "deadlineISO": "", "term_id": term_id}

    open_dt = _ensure_utc(_parse_date_any(override.get("open_dt") or override.get("openISO")))
    deadline_dt = _ensure_utc(_parse_date_any(override.get("deadline_dt") or override.get("deadlineISO")))

    openISO = open_dt.isoformat() if open_dt else ""
    deadlineISO = deadline_dt.isoformat() if deadline_dt else ""

    return {
        "openISO": openISO,
        "deadlineISO": deadlineISO,
        "term_id": term_id,
    }


@router.post("/facultyforms")
async def facultyforms_handler(
    action: str = Query("list", description="options | list | view | startWindow"),
    userId: Optional[str] = Query(None, description="(Optional) Acting user id; used as Gmail sender when available"),
    department: Optional[str] = Query(None),
    facultyType: Optional[str] = Query(None, description="Full-Time | Part-Time | All Faculty Type"),
    status: Optional[str] = Query(None, description="Submitted | Not Submitted | All Status"),
    search: Optional[str] = Query(None),
    facultyId: Optional[str] = Query(None),
    termId: Optional[str] = Query(None),
    durationDays: Optional[int] = Query(None),  # NEW
    openISO: Optional[str] = Query(None, description="(Optional) Exact open datetime in ISO 8601"),
    deadlineISO: Optional[str] = Query(None, description="(Optional) Exact deadline datetime in ISO 8601"),
):

    # ----- OPTIONS -----
    if action == "options":
        depts = [d async for d in db[COL_DEPARTMENTS].find({}, {"_id": 0, "department_name": 1, "dept_name": 1})]
        department_options = sorted({
            (d.get("department_name") or d.get("dept_name") or "").strip()
            for d in depts if (d.get("department_name") or d.get("dept_name"))
        })

        codes = await db[COL_FACULTY].distinct("employment_type")
        type_map = {"FT": "Full-Time", "PT": "Part-Time"}
        faculty_types = sorted({type_map.get(c, c) for c in codes if c})

        active = await _active_term()
        ay = active.get("acad_year_start")
        tn = active.get("term_number")
        label = (
            f"Term {tn} · AY {ay}-{ay + 1}"
            if (ay is not None and tn is not None)
            else None
        )

        # OM UI: show ONLY manual window override (if any)
        window = await _prefs_window_override_for_term(active or {})
        prefs_window = {
            "openISO": window.get("openISO") or "",
            "deadlineISO": window.get("deadlineISO") or "",
            "term_id": window.get("term_id"),
        }

        return {
            "ok": True,
            "departments": department_options,
            "facultyTypes": faculty_types,
            "activeTerm": {
                "term_id": active.get("term_id"),
                "acad_year_start": ay,
                "term_number": tn,
                "label": label,
                "submission_deadline": active.get("submission_deadline"),
            },
            "prefs_window": prefs_window,
        }

    
        # ----- START / RESTART WINDOW (OM only, called from OM UI) -----
    if action == "startWindow":
        # Resolve term (explicit termId, else active)
        if termId:
            term_doc = await db[COL_TERMS].find_one(
                {"term_id": termId},
                {
                    "_id": 0,
                    "term_id": 1,
                    "acad_year_start": 1,
                    "term_number": 1,
                    "submission_deadline": 1,
                    "start_date": 1,
                    "classes_start_date": 1,
                },
            )
        else:
            term_doc = await _active_term()

        if not term_doc or not term_doc.get("term_id"):
            raise HTTPException(status_code=400, detail="Active term not found; cannot start window.")

        term_id = term_doc["term_id"]

        # Capture previous deadline (if any) so we can notify faculty on change.
        prev_override = await db[COL_PREFS_WINDOWS].find_one(
            {"term_id": term_id},
            {"_id": 0, "deadlineISO": 1, "deadline_dt": 1},
        ) or {}
        old_deadline_iso = (prev_override.get("deadlineISO") or "").strip()

        def _parse_iso_as_utc(s: Optional[str]) -> Optional[datetime]:
            if not s:
                return None
            try:
                dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
            except Exception:
                return None
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)

        # Prefer exact schedule (like APO_CourseOfferings). If not provided, keep legacy duration-based behavior.
        open_dt = _parse_iso_as_utc(openISO)
        deadline_dt = _parse_iso_as_utc(deadlineISO)

        if open_dt and deadline_dt:
            if deadline_dt <= open_dt:
                raise HTTPException(status_code=400, detail="deadlineISO must be after openISO.")
        else:
            # Legacy: Default duration: 7 days after start, unless caller overrides
            days = durationDays if durationDays is not None else 7
            try:
                days = int(days)
            except Exception:
                days = 7
            if days <= 0:
                raise HTTPException(status_code=400, detail="durationDays must be a positive integer.")

            now = datetime.now(timezone.utc)
            open_dt = now
            deadline_dt = now + timedelta(days=days)

        # Upsert override for this term
        await db[COL_PREFS_WINDOWS].update_one(
            {"term_id": term_id},
            {
                "$set": {
                    "term_id": term_id,
                    "open_dt": open_dt,
                    "deadline_dt": deadline_dt,
                    "openISO": open_dt.isoformat(),
                    "deadlineISO": deadline_dt.isoformat(),
                    "updated_at": datetime.now(timezone.utc),
                },
                "$setOnInsert": {
                    "created_at": datetime.now(timezone.utc),
                },
            },
            upsert=True,
        )

        # Notify faculty if the deadline changed.
        await _notify_all_faculty_deadline_changed(
            term_id=term_id,
            old_deadline_iso=old_deadline_iso,
            new_deadline_iso=deadline_dt.isoformat(),
            actor_user_id=(userId or None),
        )

        # After saving the override, read back the override-only window
        window = await _prefs_window_override_for_term(term_doc)
        return {
            "ok": True,
            "prefs_window": {
                "openISO": window.get("openISO") or "",
                "deadlineISO": window.get("deadlineISO") or "",
                "term_id": window.get("term_id"),
            },
        }



    # ----- Resolve term (no parsing of termId strings) -----
    term_doc = None
    if termId:
        term_doc = await db[COL_TERMS].find_one(
            {"term_id": termId},
            {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1}
        )
    if not term_doc:
        term_doc = await _active_term()

    termId = term_doc.get("term_id")
    ay_from_term = term_doc.get("acad_year_start")

    # ----- LIST -----
    if action == "list":
        early_match: Dict[str, Any] = {}
        if facultyType and facultyType.strip().lower() != "all faculty type":
            code = {"Full-Time": "FT", "Part-Time": "PT"}.get(facultyType.strip())
            if code:
                early_match["employment_type"] = code

        dept_filter = (department or "").strip()
        if dept_filter.lower() == "all departments":
            dept_filter = ""

        pipeline: List[Dict[str, Any]] = [
            {"$match": early_match},
            {"$lookup": {
                "from": COL_DEPARTMENTS,
                "localField": "department_id",
                "foreignField": "department_id",
                "as": "dept",
            }},
            {"$unwind": {"path": "$dept", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {
                "from": COL_USERS,
                "let": {"uid": "$user_id", "femail": "$email"},
                "pipeline": [
                    {"$match": {"$expr": {"$or": [
                        {"$and": [{"$ne": ["$$uid", None]}, {"$eq": ["$user_id", "$$uid"]}]},
                        {"$and": [{"$ne": ["$$femail", None]}, {"$eq": ["$email", "$$femail"]}]},
                    ]}}},
                    {"$project": {"_id": 0, "first_name": 1, "last_name": 1, "email": 1}}
                ],
                "as": "u"
            }},
            {"$unwind": {"path": "$u", "preserveNullAndEmptyArrays": True}},

            # Pull latest preference for this faculty in this term (or same AY)
            {"$lookup": {
                "from": COL_PREFS,
                "let": {"fid": "$faculty_id", "termId": termId, "ay": ay_from_term},
                "pipeline": [
                    {"$match": {"$expr": {"$and": [
                        {"$eq": ["$faculty_id", "$$fid"]},
                        {"$or": [
                            {"$eq": ["$term_id", "$$termId"]},
                            {"$and": [
                                {"$ne": ["$$ay", None]},
                                {"$eq": ["$acad_year_start", "$$ay"]}
                            ]}
                        ]}
                    ]}}},
                    {"$sort": {"submitted_at": -1, "updated_at": -1, "created_at": -1}},
                    {"$limit": 1},
                    {"$project": {
                        "_id": 0,
                        "is_finished": 1,
                        "submitted_at": 1
                    }}
                ],
                "as": "pref"
            }},
            {"$unwind": {"path": "$pref", "preserveNullAndEmptyArrays": True}},

            {"$addFields": {
                "department_display": _dept_name_expr(),
                "name": _full_name_expr(),
                "email_display": {"$ifNull": ["$u.email", "$email"]},
                "type_display": _faculty_type_display(),
                # Status: only Submitted when is_finished == true
                "submission_status": {
                    "$cond": [{"$eq": ["$pref.is_finished", True]}, "Submitted", "Not Submitted"]
                },
                # Date: show only when submitted (drafts -> N/A)
                "submission_date": {
                    "$cond": [
                        {"$eq": ["$pref.is_finished", True]},
                        "$pref.submitted_at",
                        None
                    ]
                },
            }},

            {"$match": {"$expr": {"$or": [
                {"$eq": [dept_filter, ""]},
                {"$eq": ["$department_display", dept_filter]}
            ]}}},
        ]

        if status and status.strip().lower() != "all status":
            pipeline.append({"$match": {"submission_status": status.strip()}})

        if search and search.strip():
            s = search.strip()
            pipeline.append({"$match": {"$or": [
                {"name": {"$regex": s, "$options": "i"}},
                {"email_display": {"$regex": s, "$options": "i"}},
                {"user_id": {"$regex": s, "$options": "i"}},
            ]}})

        pipeline.extend([
            {"$project": {
                "_id": 0,
                "faculty_id": 1,
                "name": 1,
                "email": "$email_display",
                "department": "$department_display",
                "type": "$type_display",
                "submission_date": 1,
                "status": "$submission_status",
            }},
            {"$sort": {"name": 1}}
        ])

        rows = [r async for r in db[COL_FACULTY].aggregate(pipeline)]
        return {"ok": True, "rows": rows}

    # ----- VIEW -----
    if action == "view":
        if not facultyId:
            raise HTTPException(status_code=400, detail="facultyId is required.")

        pipeline: List[Dict[str, Any]] = [
            {"$match": {"faculty_id": facultyId}},
            {"$lookup": {
                "from": COL_USERS,
                "let": {"uid": "$user_id", "femail": "$email"},
                "pipeline": [
                    {"$match": {"$expr": {"$or": [
                        {"$and": [{"$ne": ["$$uid", None]}, {"$eq": ["$user_id", "$$uid"]}]},
                        {"$and": [{"$ne": ["$$femail", None]}, {"$eq": ["$email", "$$femail"]}]},
                    ]}}},
                    {"$project": {"_id": 0, "first_name": 1, "last_name": 1, "email": 1}}
                ],
                "as": "u"
            }},
            {"$unwind": {"path": "$u", "preserveNullAndEmptyArrays": True}},
            {"$addFields": {"name": _full_name_expr(), "email_display": {"$ifNull": ["$u.email", "$email"]}}},

            {"$lookup": {
                "from": COL_PREFS,
                "let": {"fid": "$faculty_id", "termId": termId, "ay": ay_from_term},
                "pipeline": [
                    {"$match": {"$expr": {"$and": [
                        {"$eq": ["$faculty_id", "$$fid"]},
                        {"$or": [
                            {"$eq": ["$term_id", "$$termId"]},
                            {"$and": [
                                {"$ne": ["$$ay", None]},
                                {"$eq": ["$acad_year_start", "$$ay"]}
                            ]}
                        ]}
                    ]}}},
                    {"$sort": {"submitted_at": -1, "updated_at": -1, "created_at": -1}},
                    {"$limit": 1},
                    {"$project": {
                        "_id": 0,
                        "preferred_units": 1,
                        "preferred_times": 1,
                        "availability_days": 1,
                        "preferred_kacs": 1,
                        "mode": 1,
                        "deloading_data": 1,
                        "notes": 1,  # remarks from faculty_preferences.notes
                        "is_finished": 1,
                        "submitted_at": 1
                    }}
                ],
                "as": "pref"
            }},
            {"$unwind": {"path": "$pref", "preserveNullAndEmptyArrays": True}},

            # Build skeleton the UI expects; we will pretty-format in Python after aggregation
            {"$addFields": {
                "teaching": {
                    "preferred_units": {"$ifNull": ["$pref.preferred_units", None]},
                    "deloading": {"$ifNull": ["$pref.deloading_data", []]},
                },
                "location_mode": {
                    "mode": {"$ifNull": ["$pref.mode", None]},
                },
                "schedule": {
                    "days": {"$ifNull": ["$pref.availability_days", []]},
                    "times": {"$ifNull": ["$pref.preferred_times", []]},
                },
                "specialization": {
                    "courses": {"$ifNull": ["$pref.preferred_kacs", []]},
                },
                "submission": {
                    "status": {
                        "$cond": [{"$eq": ["$pref.is_finished", True]}, "Submitted", "Not Submitted"]
                    },
                    "date": {
                        "$cond": [
                            {"$eq": ["$pref.is_finished", True]},
                            {"$ifNull": ["$pref.submitted_at", None]},
                            None
                        ]
                    },
                    # remarks exposed as submission.notes
                    "notes": {"$ifNull": ["$pref.notes", None]},
                }
            }},
            {"$project": {
                "_id": 0,
                "faculty_id": 1,
                "name": 1,
                "email": "$email_display",
                "teaching": 1,
                "location_mode": 1,
                "schedule": 1,
                "specialization": 1,
                "submission": 1
            }},
            {"$limit": 1}
        ]

        docs = [d async for d in db[COL_FACULTY].aggregate(pipeline)]
        if not docs:
            return {"ok": False, "preference": {}}

        out = docs[0]

        # --- Pretty-format to MATCH what faculty submitted/see ---
        # Days: expand ["MW","H"] -> ["Monday","Wednesday","Thursday"]
        out["schedule"]["days"] = _expand_day_groups(out.get("schedule", {}).get("days"))

        # Time slots: "0915-1045" -> "09:15 - 10:45"
        raw_times = out.get("schedule", {}).get("times") or []
        out["schedule"]["times"] = [_fmt_time_range(str(t)) for t in raw_times]

        # Deloading: objects -> ["Administrative — 3 units", ...]
        out["teaching"]["deloading"] = _deload_strings(out.get("teaching", {}).get("deloading"))

        # Mode: object -> readable string label
        out["location_mode"]["mode"] = await _mode_label(out.get("location_mode", {}).get("mode"))

        # KACs: normalize to names/codes (string list)
        out["specialization"]["courses"] = await _kac_strings(out.get("specialization", {}).get("courses"))

        return {"ok": True, "preference": out}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
