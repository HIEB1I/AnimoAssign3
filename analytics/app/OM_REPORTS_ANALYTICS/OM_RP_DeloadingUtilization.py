# analytics/app/OM_REPORTS_ANALYTICS/OM_RP_DeloadingUtilization.py

from typing import Any, Dict, List
from fastapi import APIRouter
from datetime import datetime
from ..main import db

router = APIRouter(prefix="/analytics", tags=["analytics"])

COL_TERMS = "terms"

async def _active_term() -> Dict[str, Any]:
    t = await db[COL_TERMS].find_one(
        {"$or": [{"status": "active"}, {"is_current": True}]},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )
    return t or {}

def _term_label(t: Dict[str, Any]) -> str:
    if not t:
        return ""
    ay = t.get("acad_year_start")
    tn = t.get("term_number")
    if not ay or tn is None:
        return ""
    return f"AY {ay}-{int(ay) + 1} T{tn}"

def _normalize_type(t: str) -> str:
    if not t:
        return "Others"
    x = t.lower()
    if x.startswith("admin"):
        return "Admin"
    if x.startswith("research"):
        return "Research"
    return "Others"

@router.get("/deloading-utilization")
async def deloading_utilization() -> Dict[str, Any]:
    """
    Returns KPI metrics and a list of active deloadings.
    Right now serves hardcoded sample data so the UI is populated even without DB rows.
    """

    # ---- SAMPLE DATA (shape mirrors the front-end expectation) ----
    sample_active: List[Dict[str, Any]] = [
        {"id": 1, "faculty": "Faculty #1", "type": "Administrative", "units": 6, "notes": "Dept. Chair — ST Department", "status": "Active"},
        {"id": 2, "faculty": "Faculty #2", "type": "Research",       "units": 5, "notes": "Dissertation Writing",         "status": "Active"},
        {"id": 3, "faculty": "Faculty #3", "type": "Extension",       "units": 3, "notes": "External Project Support",     "status": "Active"},
    ]

    # In the future, you can replace the above with actual fetches from your deloading collection(s)
    # and compute KPIs from DB rows.

    # ---- Compute KPIs from sample (or DB when wired) ----
    total_approved = sum(int(r.get("units", 0)) for r in sample_active)
    faculty_with_active = len(sample_active)
    used_units = total_approved
    denom = used_units
    utilization = 100 if used_units > 0 else 0

    by_type: Dict[str, int] = {"Admin": 0, "Research": 0, "Others": 0}
    for r in sample_active:
        by_type[_normalize_type(str(r.get("type", "")))] += int(r.get("units", 0))

    active_term = await _active_term()

    return {
        "ok": True,
        "meta": {"term_label": _term_label(active_term)},
        "metrics": {
            "totalApproved": total_approved,
            "facultyWithActive": faculty_with_active,
            "utilization": utilization,
            "usedUnits": used_units,
            "denom": denom,
            "activeByType": by_type,
        },
        "active": sample_active,
        "generated_at": datetime.utcnow().isoformat() + "Z",
    }
