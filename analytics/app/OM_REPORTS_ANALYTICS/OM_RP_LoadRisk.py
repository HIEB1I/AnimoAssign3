# backend/app/OM/OM_REPORTS_ANALYTICS/OM_RP_LoadRisk.py
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

@router.get("/load-risk")
async def load_risk() -> Dict[str, Any]:
    """
    Returns hardcoded sample course rows used by the Load Risk UI.
    You can swap the 'courses' list with DB-driven values later.
    The shape mirrors the ANA mock so the frontend can compute metrics.
    """
    courses: List[Dict[str, Any]] = [
        {"course_id":"C001","course_code":"CCPROG1","course_name":"Computer Programming 1","sections_planned":6,"cap_per_section":45,"forecast_enrollees":260,"qualified_ft_count":5,"qualified_pt_pool":3,"avg_sections_per_ft":1.2,"leave_probability":0.18,"historical_fill_rate":0.97,"program_area":"Foundations"},
        {"course_id":"C002","course_code":"CCPROG2","course_name":"Computer Programming 2","sections_planned":5,"cap_per_section":45,"forecast_enrollees":210,"qualified_ft_count":4,"qualified_pt_pool":2,"avg_sections_per_ft":1.1,"leave_probability":0.25,"historical_fill_rate":0.94,"program_area":"Foundations"},
        {"course_id":"C003","course_code":"CCPROG3","course_name":"Data Structures","sections_planned":5,"cap_per_section":45,"forecast_enrollees":230,"qualified_ft_count":4,"qualified_pt_pool":2,"avg_sections_per_ft":1.0,"leave_probability":0.22,"historical_fill_rate":0.92,"program_area":"Core"},
        {"course_id":"C004","course_code":"CSADPRG","course_name":"Advanced Programming","sections_planned":4,"cap_per_section":45,"forecast_enrollees":190,"qualified_ft_count":3,"qualified_pt_pool":2,"avg_sections_per_ft":1.0,"leave_probability":0.35,"historical_fill_rate":0.89,"program_area":"Core"},
        {"course_id":"C005","course_code":"CSSWENG","course_name":"Software Engineering","sections_planned":6,"cap_per_section":45,"forecast_enrollees":270,"qualified_ft_count":5,"qualified_pt_pool":3,"avg_sections_per_ft":1.1,"leave_probability":0.28,"historical_fill_rate":0.90,"program_area":"SE"},
        {"course_id":"C006","course_code":"CSINTSY","course_name":"Intelligent Systems","sections_planned":3,"cap_per_section":45,"forecast_enrollees":130,"qualified_ft_count":2,"qualified_pt_pool":2,"avg_sections_per_ft":1.0,"leave_probability":0.32,"historical_fill_rate":0.86,"program_area":"AI/ML"},
        {"course_id":"C007","course_code":"CSALGCM","course_name":"Algorithms","sections_planned":4,"cap_per_section":45,"forecast_enrollees":180,"qualified_ft_count":3,"qualified_pt_pool":1,"avg_sections_per_ft":1.0,"leave_probability":0.15,"historical_fill_rate":0.95,"program_area":"Core"},
        {"course_id":"C008","course_code":"DATALG","course_name":"Data Analytics","sections_planned":3,"cap_per_section":45,"forecast_enrollees":160,"qualified_ft_count":2,"qualified_pt_pool":2,"avg_sections_per_ft":1.0,"leave_probability":0.40,"historical_fill_rate":0.84,"program_area":"Data"},
        {"course_id":"C009","course_code":"MOBDEVE","course_name":"Mobile Development","sections_planned":3,"cap_per_section":45,"forecast_enrollees":150,"qualified_ft_count":2,"qualified_pt_pool":2,"avg_sections_per_ft":1.0,"leave_probability":0.30,"historical_fill_rate":0.88,"program_area":"Platforms"},
        {"course_id":"C010","course_code":"CSMODEL","course_name":"Modeling & Simulation","sections_planned":2,"cap_per_section":45,"forecast_enrollees":100,"qualified_ft_count":1,"qualified_pt_pool":1,"avg_sections_per_ft":1.0,"leave_probability":0.40,"historical_fill_rate":0.80,"program_area":"Core"},
        {"course_id":"C011","course_code":"CSOPESY","course_name":"Operating Systems","sections_planned":3,"cap_per_section":45,"forecast_enrollees":130,"qualified_ft_count":2,"qualified_pt_pool":2,"avg_sections_per_ft":1.0,"leave_probability":0.20,"historical_fill_rate":0.90,"program_area":"Systems"},
        {"course_id":"C012","course_code":"CSMATH1","course_name":"Discrete Mathematics","sections_planned":4,"cap_per_section":45,"forecast_enrollees":190,"qualified_ft_count":3,"qualified_pt_pool":2,"avg_sections_per_ft":1.0,"leave_probability":0.10,"historical_fill_rate":0.96,"program_area":"Math"},
        {"course_id":"C013","course_code":"CSMATH2","course_name":"Probability & Statistics","sections_planned":4,"cap_per_section":45,"forecast_enrollees":185,"qualified_ft_count":3,"qualified_pt_pool":2,"avg_sections_per_ft":1.0,"leave_probability":0.14,"historical_fill_rate":0.93,"program_area":"Math"},
        {"course_id":"C014","course_code":"THS-ST2","course_name":"Thesis Studio 2","sections_planned":2,"cap_per_section":45,"forecast_enrollees":85,"qualified_ft_count":1,"qualified_pt_pool":1,"avg_sections_per_ft":1.0,"leave_probability":0.33,"historical_fill_rate":0.82,"program_area":"Capstone"},
        {"course_id":"C015","course_code":"THS-ST3","course_name":"Thesis Studio 3","sections_planned":2,"cap_per_section":45,"forecast_enrollees":90,"qualified_ft_count":1,"qualified_pt_pool":1,"avg_sections_per_ft":1.0,"leave_probability":0.36,"historical_fill_rate":0.81,"program_area":"Capstone"},
    ]

    active = await _active_term()

    return {
        "ok": True,
        "meta": {"term_label": _term_label(active)},
        "courses": courses,
        "generated_at": datetime.utcnow().isoformat() + "Z",
    }
