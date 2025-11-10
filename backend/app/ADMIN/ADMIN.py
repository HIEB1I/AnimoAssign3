from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query, Body
from datetime import datetime

# Reuse the shared Mongo client/db created in main.py
from ..main import db  # type: ignore

router = APIRouter(prefix="/admin", tags=["admin"])

# -----------------------------
# Helpers
# -----------------------------
async def _get_role_type_for_user(user_id: str) -> Optional[str]:
    """role_assignments.user_id -> user_roles.role_type"""
    ra = await db.role_assignments.find_one({"user_id": user_id})
    if not ra:
        return None
    role_id = ra.get("role_id")
    if not role_id:
        return None
    role = await db.user_roles.find_one({"role_id": role_id})
    return role.get("role_type") if role else None

async def _get_dept_code_for_user(user_id: str) -> Optional[str]:
    """
    Try faculty_profiles → departments, then student_profiles → departments.
    Return dept_code (e.g., 'ST'). If not found, None.
    """
    # faculty
    fac = await db.faculty_profiles.find_one({"user_id": user_id})
    if fac and fac.get("department_id"):
        dept = await db.departments.find_one({"department_id": fac["department_id"]})
        if dept and dept.get("dept_code"):
            return dept["dept_code"]

    # student
    stu = await db.student_profiles.find_one({"user_id": user_id})
    if stu and stu.get("department_id"):
        dept = await db.departments.find_one({"department_id": stu["department_id"]})
        if dept and dept.get("dept_code"):
            return dept["dept_code"]

    # staff (schema may not have department_id in sample; try just in case)
    staff = await db.staff_profiles.find_one({"user_id": user_id})
    if staff and staff.get("department_id"):
        dept = await db.departments.find_one({"department_id": staff["department_id"]})
        if dept and dept.get("dept_code"):
            return dept["dept_code"]

    return None

def _bool_status_to_label(val: Any) -> str:
    # users.status is boolean in your sample; map to 'Active'/'Inactive'.
    return "Active" if bool(val) else "Inactive"

def _format_fullname(last_name: Optional[str], first_name: Optional[str]) -> str:
    ln = (last_name or "").strip()
    fn = (first_name or "").strip()
    if not (ln or fn):
        return "Unknown User"
    return f"{ln}, {fn}".strip(", ")

def _iso_to_local_date(date_str: Optional[str]) -> str:
    # Return YYYY-MM-DD (or raw if parsing fails)
    if not date_str:
        return ""
    try:
        # support strings with timezone like "2024-09-01T00:00:00+08:00"
        dt = datetime.fromisoformat(str(date_str).replace("Z", "+00:00"))
        return dt.date().isoformat()
    except Exception:
        return str(date_str)

# -----------------------------
# Endpoints
# -----------------------------
@router.get("/users")
async def get_admin_users() -> Dict[str, Any]:
    """
    Returns rows for the User Management table with the exact fields the UI needs:
      fullName (last_name, first_name)
      email (email)
      status (status -> 'Active'|'Inactive')
      role (role_type via role_assignments -> user_roles)
      department (dept_code via *profiles* -> departments)
      joinedDate (created_at)
    """
    cursor = db.users.find({})
    out: List[Dict[str, Any]] = []
    i = 0
    async for u in cursor:
        user_id = u.get("user_id")
        role_type = await _get_role_type_for_user(user_id) if user_id else None
        dept_code = await _get_dept_code_for_user(user_id) if user_id else None

        i += 1
        row = {
            "id": i,
            "fullName": _format_fullname(u.get("last_name"), u.get("first_name")),
            "email": u.get("email", ""),
            "status": _bool_status_to_label(u.get("status")),
            "role": role_type or "Unknown",
            "department": dept_code or "N/A",
            "joinedDate": _iso_to_local_date(u.get("created_at")),
        }
        out.append(row)

    return {"ok": True, "users": out}


@router.get("/logs")
async def get_admin_logs() -> Dict[str, Any]:
    """
    Returns rows for the Audit Logs table with:
      user (Full Name from users by user_id)
      action (action)
      details (remarks)
      timestamp (timestamp, split-friendly)
    NOTE: No 'status' column by design (removed per request).
    """
    cursor = db.audit_logs.find({}).sort("timestamp", -1)
    out: List[Dict[str, Any]] = []
    i = 0
    async for log in cursor:
        uid = log.get("user_id")
        full = "Unknown User"
        if uid:
            u = await db.users.find_one({"user_id": uid})
            if u:
                full = _format_fullname(u.get("last_name"), u.get("first_name"))
        ts = log.get("timestamp")
        # Keep ISO-ish but provide a space-separated fallback for the UI splitter.
        try:
            dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
            ts_fmt = f"{dt.date().isoformat()} {dt.time().strftime('%H:%M:%S')}"
        except Exception:
            ts_fmt = str(ts)

        i += 1
        out.append(
            {
                "id": i,
                "user": full,
                "action": log.get("action", ""),
                "details": log.get("remarks", ""),
                "timestamp": ts_fmt,
            }
        )
    return {"ok": True, "logs": out}

@router.post("/manage")
async def admin_manage(
    userId: str = Query(..., min_length=3),
    action: str = Query("fetch", description="fetch | logs | options | profile | submit"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    """
    Unified Admin Management Endpoint
    ---------------------------------
    action=fetch     → Return all users
    action=logs      → Return audit logs
    action=options   → Return dropdown filter data
    action=profile   → Return profile for given userId
    action=submit    → Stub endpoint (no-op, logs attempt)
    """

    # ---------- FETCH: users ----------
    if action == "fetch":
        cursor = db.users.find({})
        out: List[Dict[str, Any]] = []
        i = 0
        async for u in cursor:
            uid = u.get("user_id")
            role_type = await _get_role_type_for_user(uid) if uid else None
            dept_code = await _get_dept_code_for_user(uid) if uid else None
            i += 1
            out.append(
                {
                    "id": i,
                    "fullName": _format_fullname(u.get("last_name"), u.get("first_name")),
                    "email": u.get("email", ""),
                    "status": _bool_status_to_label(u.get("status")),
                    "role": role_type or "Unknown",
                    "department": dept_code or "N/A",
                    "joinedDate": _iso_to_local_date(u.get("created_at")),
                }
            )
        return {"ok": True, "users": out}

    # ---------- LOGS ----------
    if action == "logs":
        cursor = db.audit_logs.find({}).sort("timestamp", -1)
        out: List[Dict[str, Any]] = []
        i = 0
        async for log in cursor:
            uid = log.get("user_id")
            full = "Unknown User"
            if uid:
                u = await db.users.find_one({"user_id": uid})
                if u:
                    full = _format_fullname(u.get("last_name"), u.get("first_name"))
            ts = log.get("timestamp")
            try:
                dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
                ts_fmt = f"{dt.date().isoformat()} {dt.time().strftime('%H:%M:%S')}"
            except Exception:
                ts_fmt = str(ts)
            i += 1
            out.append(
                {
                    "id": i,
                    "user": full,
                    "action": log.get("action", ""),
                    "details": log.get("remarks", ""),
                    "timestamp": ts_fmt,
                }
            )
        return {"ok": True, "logs": out}

    # ---------- OPTIONS ----------
    if action == "options":
        roles = [r async for r in db.user_roles.find({}, {"_id": 0, "role_type": 1})]
        role_types = sorted({(r.get("role_type") or "").strip() for r in roles if r.get("role_type")})
        depts = [d async for d in db.departments.find({}, {"_id": 0, "dept_code": 1})]
        dept_codes = sorted({(d.get("dept_code") or "").strip() for d in depts if d.get("dept_code")})
        return {
            "ok": True,
            "roles": role_types,
            "departments": dept_codes,
            "statuses": ["Active", "Inactive"],
        }

    # ---------- PROFILE ----------
    if action == "profile":
        u = await db.users.find_one(
            {"user_id": userId},
            {"_id": 0, "first_name": 1, "last_name": 1, "email": 1},
        )
        return {
            "ok": bool(u),
            "first_name": (u or {}).get("first_name", ""),
            "last_name": (u or {}).get("last_name", ""),
            "email": (u or {}).get("email", ""),
        }

    # ---------- SUBMIT (stub) ----------
    if action == "submit":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload")

        await db.audit_logs.insert_one(
            {
                "log_id": f"AL-STUB-{datetime.utcnow().timestamp()}",
                "user_id": userId,
                "action": "admin_submit_stub",
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "remarks": "Submit endpoint hit (no-op).",
                "label_name": "N/A",
                "record_id": "N/A",
            }
        )
        return {"ok": True, "message": "Submit accepted (no-op)."}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")

