from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query, Body
from datetime import datetime

# Reuse the shared Mongo client/db created in main.py
from ..main import db  # type: ignore

router = APIRouter(prefix="/admin", tags=["admin"])

# -----------------------------
# Helpers
# -----------------------------
def _format_fullname(last_name: Optional[str], first_name: Optional[str]) -> str:
    ln = (last_name or "").strip()
    fn = (first_name or "").strip()
    if not (ln or fn):
        return "Unknown User"
    return f"{ln}, {fn}".strip(", ")

# -----------------------------
# Endpoints
# -----------------------------

@router.get("/logs")
async def get_admin_logs() -> Dict[str, Any]:
    """
    Returns rows for the Audit Logs table with:
      user (Full Name from users by user_id)
      action (action)
      details (remarks)
      timestamp (timestamp, split-friendly)
    NOTE: No 'status' column by design.
    """
    cursor = db.audit_logs.find({}).sort("timestamp", -1)
    out: List[Dict[str, Any]] = []
    i = 0
    async for log in cursor:
        uid = log.get("user_id")
        full = "Unknown User"
        if uid:
            # We still read the user name for the log display, 
            # but we don't manage the user here.
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

@router.post("/manage")
async def admin_manage(
    userId: str = Query(..., min_length=3),
    action: str = Query("logs", description="logs"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    """
    Unified Admin Management Endpoint
    ---------------------------------
    action=logs      → Return audit logs
    """

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

    raise HTTPException(status_code=400, detail="Invalid action parameter or feature disabled.")