from typing import Any, Dict, List, Optional
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, HTTPException, Query, Body
from ..main import db
from ..Notifications import create_notification
router = APIRouter(prefix="/om", tags=["om"])

# --- collections ---
COL_PETITIONS = "student_petitions"
COL_TERMS = "terms"
COL_COURSES = "courses"
COL_DEPARTMENTS = "departments"
COL_USERS = "users"
COL_ROLE_ASSIGN = "role_assignments"
COL_USER_ROLES = "user_roles"
COL_PREEN_COUNT = "preenlistment_count" 
COL_PETITION_WINDOWS = "student_petition_windows"


# --- helpers ---
# --- helpers ---
async def _active_term() -> Dict[str, Any]:
    """
    Return the WORKING / PLANNING term for OM student petitions.

    Priority:
    1) If there is an active (non-archived) pre-enlistment batch in
       preenlistment_count, use that term_id.
    2) Otherwise, use the *next* term after the current term
       (where is_current = True or status = 'active').
    3) If there is no "next" term configured, fall back to the current term
       (or latest AY/term_number if nothing is flagged current/active).
    """

    # 1) Try to derive from an active pre-enlistment batch
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

    # 2) Fallback: current term (status = active OR is_current = True)
    current = await db[COL_TERMS].find_one(
        {"$or": [{"status": "active"}, {"is_current": True}]},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )

    if not current:
        # Same fallback as before: latest term by AY + term_number
        last = await db[COL_TERMS].find(
            {}, {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1}
        ).sort([("acad_year_start", -1), ("term_number", -1)]).limit(1).to_list(1)
        current = last[0] if last else None

    if not current:
        # No terms configured at all
        return {}

    # 3) Compute the "next" term after the current term
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

    if next_terms:
        # Use the next term as the working/planning term
        return next_terms[0]

    # If no next term, stick with current (still better than returning nothing)
    return current



def _parse_date_any(dt):
    if isinstance(dt, datetime):
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    if not dt:
        return None
    try:
        parsed = datetime.fromisoformat(str(dt).replace("Z", "+00:00"))
    except Exception:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


async def _petition_window_override_for_term(term: Dict[str, Any]) -> Dict[str, Any]:
    term = term or {}
    term_id = term.get("term_id")
    if not term_id:
        return {"openISO": "", "deadlineISO": "", "term_id": None}

    override = await db[COL_PETITION_WINDOWS].find_one(
        {"term_id": term_id},
        {"_id": 0, "open_dt": 1, "deadline_dt": 1, "openISO": 1, "deadlineISO": 1, "term_id": 1},
    )
    if not override:
        return {"openISO": "", "deadlineISO": "", "term_id": term_id}

    open_dt = _parse_date_any(override.get("open_dt") or override.get("openISO"))
    deadline_dt = _parse_date_any(override.get("deadline_dt") or override.get("deadlineISO"))
    return {
        "openISO": open_dt.isoformat() if open_dt else "",
        "deadlineISO": deadline_dt.isoformat() if deadline_dt else "",
        "term_id": term_id,
    }


def _course_code_expr():
    # Normalize string | array to a single display code
    return {
        "$cond": [
            {"$isArray": "$course.course_code"},
            {"$ifNull": [{"$arrayElemAt": ["$course.course_code", 0]}, ""]},
            {"$ifNull": ["$course.course_code", ""]},
        ]
    }


# --- route ---
@router.post("/student-petition")
async def om_student_petitions_handler(
    action: str = Query("list", description="options | list | update | bulkForward | header | startWindow"),
    status: Optional[str] = Query(None, description="Filter by last status (list)"),
    search: Optional[str] = Query(None, description="Search by course code/title (list)"),
    courseId: Optional[str] = Query(None, description="For single update"),
    termId: Optional[str] = Query(None, description="Override active term"),
    userEmail: Optional[str] = Query(None, description="Header: user email"),
    userId: Optional[str] = Query(None, description="Header: user id"),
    durationDays: Optional[int] = Query(None),
    openISO: Optional[str] = Query(None, description="(Optional) Exact open datetime in ISO 8601"),
    deadlineISO: Optional[str] = Query(None, description="(Optional) Exact deadline datetime in ISO 8601"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    """
    Single endpoint for OM Student Petition:
      - header:     topbar profile name + subtitle (role | department)
      - options:    statuses + active term label
      - list:       groups petitions by course in active term (count + latest status/remarks)
      - update:     updates status/remarks for all petitions of a course in active term
      - bulkForward:set status for multiple course_ids in active term
    """

    # ---------- HEADER (Topbar identity) ----------
    if action == "header":
        if not userEmail and not userId:
            raise HTTPException(status_code=400, detail="userEmail or userId is required.")

        match: Dict[str, Any] = {"user_id": userId} if userId else {"email": userEmail}

        pipeline: List[Dict[str, Any]] = [
            {"$match": match},
            {"$project": {"_id": 0, "user_id": 1, "email": 1, "first_name": 1, "last_name": 1}},

            # Link role assignments (may be multiple; we just take the first)
            {"$lookup": {
                "from": COL_ROLE_ASSIGN,
                "let": {"uid": "$user_id"},
                "pipeline": [{"$match": {"$expr": {"$eq": ["$user_id", "$$uid"]}}}],
                "as": "ra_list"
            }},
            {"$unwind": {"path": "$ra_list", "preserveNullAndEmptyArrays": True}},

            # Compute department_id from scope[] (scope elements look like {type:"department", id:"DEPT0003"})
            {"$addFields": {
                "ra": "$ra_list",
                "department_id": {
                    "$let": {
                        "vars": {"sc": {"$ifNull": ["$ra_list.scope", []]}},
                        "in": {"$first": {
                            "$map": {
                                "input": {
                                    "$filter": {
                                        "input": "$$sc",
                                        "as": "s",
                                        "cond": {"$eq": ["$$s.type", "department"]}
                                    }
                                },
                                "as": "d",
                                "in": "$$d.id"
                            }
                        }}
                    }
                }
            }},

            # Join department using computed department_id
            {"$lookup": {
                "from": COL_DEPARTMENTS,
                "localField": "department_id",
                "foreignField": "department_id",
                "as": "dept"
            }},
            {"$unwind": {"path": "$dept", "preserveNullAndEmptyArrays": True}},

            # Resolve role_type through user_roles
            {"$lookup": {
                "from": COL_USER_ROLES,
                "localField": "ra.role_id",
                "foreignField": "role_id",
                "as": "role"
            }},
            {"$unwind": {"path": "$role", "preserveNullAndEmptyArrays": True}},

            {"$addFields": {
                "full_name": {
                    "$trim": {"input": {"$concat": [
                        {"$ifNull": ["$first_name", ""]}, " ", {"$ifNull": ["$last_name", ""]}
                    ]}}
                },
                "dept_name": {"$ifNull": ["$dept.department_name", "$dept.dept_name"]},
                "role_type": {"$ifNull": ["$role.role_type", ""]},
            }},

            {"$project": {
                "_id": 0,
                "email": 1,
                "department_id": 1,  # computed above
                "role_type": 1,
                "profileName": "$full_name",
                "profileSubtitle": {
                    "$trim": {"input": {"$concat": [
                        {"$ifNull": ["$role_type", ""]},
                        {"$cond": [{"$ifNull": ["$dept_name", False]}, " | ", ""]},
                        {"$ifNull": ["$dept_name", ""]},
                    ]}}
                }
            }},
            {"$limit": 1}
        ]

        docs = [d async for d in db[COL_USERS].aggregate(pipeline)]
        if not docs:
            return {"ok": False, "message": "User not found."}
        return {"ok": True, **docs[0]}

    # Everything else needs an active term
    active = await _active_term()
    current_term_id = termId or active.get("term_id")
    if not current_term_id and action in {"list", "update", "bulkForward"}:
        raise HTTPException(status_code=503, detail="No active term configured.")

    # ---------- OPTIONS ----------
    if action == "options":
        cfg = await db[COL_PETITIONS].find_one(
            {"_id": "config", "doc_type": {"$in": ["config", "Config"]}},
            {"_id": 0, "statuses": 1},
        )
        statuses = (cfg or {}).get("statuses") or []
        window = await _petition_window_override_for_term(active or {})
        return {
            "ok": True,
            "statuses": statuses,
            "activeTerm": {
                "term_id": active.get("term_id", ""),
                "acad_year_start": active.get("acad_year_start"),
                "term_number": active.get("term_number"),
            },
            "submission_window": {
                "openISO": window.get("openISO") or "",
                "deadlineISO": window.get("deadlineISO") or "",
                "term_id": window.get("term_id"),
            },
        }

    if action == "startWindow":
        if termId:
            term_doc = await db[COL_TERMS].find_one(
                {"term_id": termId},
                {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
            )
        else:
            term_doc = active or await _active_term()

        if not term_doc or not term_doc.get("term_id"):
            raise HTTPException(status_code=400, detail="Active term not found; cannot start window.")

        term_id = term_doc["term_id"]

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

        open_dt = _parse_iso_as_utc(openISO)
        deadline_dt = _parse_iso_as_utc(deadlineISO)
        if open_dt and deadline_dt:
            if deadline_dt <= open_dt:
                raise HTTPException(status_code=400, detail="deadlineISO must be after openISO.")
        else:
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

        await db[COL_PETITION_WINDOWS].update_one(
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
                "$setOnInsert": {"created_at": datetime.now(timezone.utc)},
            },
            upsert=True,
        )

        window = await _petition_window_override_for_term(term_doc)
        return {
            "ok": True,
            "submission_window": {
                "openISO": window.get("openISO") or "",
                "deadlineISO": window.get("deadlineISO") or "",
                "term_id": window.get("term_id"),
            },
        }

    # ---------- LIST (grouped by course) ----------
    if action == "list":
        pipeline: List[Dict[str, Any]] = [
            {"$match": {"term_id": current_term_id, "petition_id": {"$exists": True}}},
            {"$sort": {"submitted_at": 1}},  # ensure $last is latest
            {"$group": {
                "_id": "$course_id",
                "count": {"$sum": 1},
                "last_status": {"$last": "$status"},
                "last_remarks": {"$last": "$remarks"},
            }},
            {"$lookup": {
                "from": COL_COURSES,
                "localField": "_id",
                "foreignField": "course_id",
                "as": "course"
            }},
            {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
            {"$addFields": {
                "course_code": _course_code_expr(),
                "course_title": {"$ifNull": ["$course.course_title", ""]},
            }},
        ]

        if search and search.strip():
            s = search.strip()
            pipeline.append({"$match": {
                "$or": [
                    {"course_code": {"$regex": s, "$options": "i"}},
                    {"course_title": {"$regex": s, "$options": "i"}},
                ]
            }})

        pipeline += [
            {"$project": {
                "_id": 0,
                "course_id": {"$ifNull": ["$_id", ""]},
                "course_code": 1,
                "course_title": 1,
                "count": 1,
                "status": "$last_status",
                "remarks": {"$ifNull": ["$last_remarks", ""]},
            }},
            {"$sort": {"course_code": 1}},
        ]

        rows = [r async for r in db[COL_PETITIONS].aggregate(pipeline)]

        threshold_managed_statuses = {"", "Less Than Minimum", "Forwarded To Department"}
        status_filter = (status or "").strip()
        if status_filter.lower() == "all status":
            status_filter = ""

        normalized_rows: List[Dict[str, Any]] = []
        for row in rows:
            count = int(row.get("count") or 0)
            raw_status = str(row.get("status") or "").strip()
            effective_status = raw_status

            if raw_status in threshold_managed_statuses:
                effective_status = "Forwarded To Department" if count >= 15 else "Less Than Minimum"

            highlight_yellow = count >= 15 and effective_status == "Forwarded To Department"

            normalized = {
                **row,
                "status": effective_status,
                "highlight_yellow": highlight_yellow,
            }
            if status_filter and effective_status != status_filter:
                continue
            normalized_rows.append(normalized)

        return {"ok": True, "rows": normalized_rows, "term_id": current_term_id}

    # ---------- UPDATE (single course) ----------
    if action == "update":
        if not courseId:
            raise HTTPException(status_code=400, detail="courseId is required.")
        if not payload:
            raise HTTPException(status_code=400, detail="payload is required.")
        new_status = (payload.get("status") or "").strip()

        # Allow clearing remarks (""), only if key is present
        remarks_present = "remarks" in payload
        new_remarks = (payload.get("remarks") or "") if remarks_present else None

        # validate against config.statuses (optional)
        if new_status:
            cfg = await db[COL_PETITIONS].find_one(
                {"_id": "config", "doc_type": {"$in": ["config", "Config"]}},
                {"_id": 0, "statuses": 1},
            )
            allowed = set((cfg or {}).get("statuses") or [])
            if allowed and new_status not in allowed:
                raise HTTPException(status_code=400, detail="Invalid status value.")

        updates: Dict[str, Any] = {}
        if new_status:
            updates["status"] = new_status
        if remarks_present:
            updates["remarks"] = new_remarks

        if not updates:
            return {"ok": False, "message": "Nothing to update."}

        res = await db[COL_PETITIONS].update_many(
            {"term_id": current_term_id, "course_id": courseId, "petition_id": {"$exists": True}},
            {"$set": updates},
        )
        # --- notify students affected by this course update (best-effort) ---
        try:
            uids = await db[COL_PETITIONS].distinct(
                "user_id",
                {"term_id": current_term_id, "course_id": courseId, "petition_id": {"$exists": True}},
            )
            uids = [str(u).strip() for u in (uids or []) if str(u).strip()]
            if uids and res.modified_count:
                course = await db[COL_COURSES].find_one(
                    {"course_id": courseId},
                    {"_id": 0, "course_code": 1, "course_title": 1},
                ) or {}
                cc = course.get("course_code")
                course_code = (cc[0] if isinstance(cc, list) and cc else cc) or ""
                course_code = str(course_code or "").strip()
                course_title = str(course.get("course_title") or "").strip()

                title = "Student Petition updated"
                parts = []
                if course_code or course_title:
                    parts.append(f"Course: {course_code} — {course_title}".strip(" —"))
                if new_status:
                    parts.append(f"Status: {new_status}")
                if remarks_present:
                    parts.append(f"Remarks: {new_remarks or ''}")
                details = "\n".join([p for p in parts if p]) or "Your petition was updated."

                meta = {
                    "route": "/student/petition",
                    "kind": "student_petition_updated",
                    "term_id": current_term_id,
                    "course_id": courseId,
                }

                actor = (userId or "").strip() if isinstance(userId, str) else None
                for uid in uids:
                    await create_notification(
                        user_id=uid,
                        title=title,
                        details=details,
                        meta=meta,
                        send_email=True,
                        email_from_user_id=actor or None,
                    )
        except Exception:
            pass

        return {"ok": True, "matched": res.matched_count, "modified": res.modified_count}

    # ---------- BULK FORWARD ----------
    if action == "bulkForward":
        if not payload or not isinstance(payload.get("course_ids"), list):
            raise HTTPException(status_code=400, detail="payload.course_ids must be an array.")
        target_status = (payload.get("status") or "Forwarded To Department").strip()

        cfg = await db[COL_PETITIONS].find_one(
            {"_id": "config", "doc_type": {"$in": ["config", "Config"]}},
            {"_id": 0, "statuses": 1},
        )
        allowed = set((cfg or {}).get("statuses") or [])
        if allowed and target_status not in allowed:
            raise HTTPException(status_code=400, detail="Invalid status value.")

        res = await db[COL_PETITIONS].update_many(
            {"term_id": current_term_id, "course_id": {"$in": payload["course_ids"]}, "petition_id": {"$exists": True}},
            {"$set": {"status": target_status}},
        )
        # --- notify students affected by bulk forward (best-effort) ---
        try:
            course_ids = [str(x).strip() for x in (payload.get("course_ids") or []) if str(x).strip()]
            if course_ids and res.modified_count:
                # Map course_id -> course_code (best-effort)
                course_docs = await db[COL_COURSES].find(
                    {"course_id": {"$in": course_ids}},
                    {"_id": 0, "course_id": 1, "course_code": 1},
                ).to_list(5000)
                code_map: Dict[str, str] = {}
                for c in course_docs or []:
                    cid = str(c.get("course_id") or "").strip()
                    cc = c.get("course_code")
                    disp = (cc[0] if isinstance(cc, list) and cc else cc) or ""
                    code_map[cid] = str(disp or "").strip() or cid

                # Group affected courses per student
                by_user: Dict[str, set] = {}
                cur = db[COL_PETITIONS].find(
                    {"term_id": current_term_id, "course_id": {"$in": course_ids}, "petition_id": {"$exists": True}},
                    {"_id": 0, "user_id": 1, "course_id": 1},
                )
                async for d in cur:
                    uid = str(d.get("user_id") or "").strip()
                    cid = str(d.get("course_id") or "").strip()
                    if not uid or not cid:
                        continue
                    by_user.setdefault(uid, set()).add(cid)

                actor = (userId or "").strip() if isinstance(userId, str) else None
                for uid, cset in (by_user or {}).items():
                    codes = [code_map.get(cid, cid) for cid in sorted(cset)]
                    show = ", ".join(codes[:12])
                    if len(codes) > 12:
                        show += f" (+{len(codes) - 12} more)"

                    await create_notification(
                        user_id=uid,
                        title="Student Petition updated",
                        details=f"Your petition status was updated to: {target_status}\nCourses: {show}",
                        meta={
                            "route": "/student/petition",
                            "kind": "student_petition_bulk_forward",
                            "term_id": current_term_id,
                        },
                        send_email=True,
                        email_from_user_id=actor or None,
                    )
        except Exception:
            pass

        return {"ok": True, "matched": res.matched_count, "modified": res.modified_count, "status": target_status}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
