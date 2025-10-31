# backend/app/OM/OM_REPORTS_ANALYTICS/OM_ReportsAnalytics.py
from typing import Any, Dict, List
from fastapi import APIRouter
from ..main import db  # noqa: F401  (kept for future use / joins)

router = APIRouter(prefix="/om", tags=["om"])

@router.get("/reports-analytics/cards")
async def list_report_cards() -> Dict[str, Any]:
    """
    Minimal endpoint to supply card metadata to the frontend when needed.
    (UI is static today, but this keeps the pattern consistent with OM_LoadAssignment.)
    """
    insight_cards: List[Dict[str, str]] = [
        {
            "title": "Teaching History per Faculty",
            "to": "/reports/teaching-history",
            "key": "insight-teaching-history",
        },
        {
            "title": "Course History",
            "to": "/reports/course-history",
            "key": "insight-course-history",
        },
        {
            "title": "Deloading Utilization Report",
            "to": "/reports/deloading-utilization",
            "key": "insight-deloading-utilization",
        },
    ]

    forecast_cards: List[Dict[str, str]] = [
        {
            "title": "Faculty Availability Forecasting",
            "to": "/reports/faculty-availability-forecast",
            "key": "forecast-availability",
        },
        {
            "title": "Faculty Load Risk Forecast",
            "to": "/reports/faculty-load-risk",
            "key": "forecast-load-risk",
        },
    ]

    return {
        "ok": True,
        "insights": insight_cards,
        "forecasts": forecast_cards,
    }
