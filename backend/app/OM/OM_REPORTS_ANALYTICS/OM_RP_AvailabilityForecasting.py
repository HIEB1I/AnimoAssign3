# backend/app/OM/OM_REPORTS_ANALYTICS/OM_RP_AvailabilityForecasting.py
from typing import Any, Dict, List, Literal, Optional
from fastapi import APIRouter
from datetime import datetime
from ...main import db

router = APIRouter(prefix="/analytics", tags=["analytics"])

COL_TERMS = "terms"

DayPairId = Literal["mon_thu", "tue_fri", "wed_sat"]

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

@router.get("/availability-forecast")
async def availability_forecast() -> Dict[str, Any]:
    """
    Returns sample forecast data for the Availability Forecasting UI.
    Replace the 'sample_*' blocks with real computations when ready.
    """
    active = await _active_term()

    # --- SAMPLE MASTER DATA (matches UI exactly) ---
    day_pairs: List[Dict[str, str]] = [
        {"id": "mon_thu", "label": "Mon–Thu"},
        {"id": "tue_fri", "label": "Tue–Fri"},
        {"id": "wed_sat", "label": "Wed–Sat"},
    ]

    # keep labels tight like ANA variant (shorter for column widths)
    time_slots: List[str] = [
        "07:30 – 09:00",
        "09:15 – 10:45",
        "11:00 – 12:30",
        "12:45 – 14:15",
        "14:30 – 16:00",
        "16:15 – 17:45",
        "18:00 – 19:30",
        "19:45 – 20:00",
    ]

    # per-daypair predicted availability counts (same as ANA mock)
    forecast: Dict[DayPairId, List[int]] = {
        "mon_thu": [19, 22, 25, 18, 13, 9, 5],
        "tue_fri": [21, 26, 24, 19, 14, 10, 6],
        "wed_sat": [10, 15, 19, 17, 16, 9, 4],
    }

    # Faculty by slot (available/unavailable) — excerpted from ANA mock
    def F(id: str, name: str, email: str, p: float) -> Dict[str, Any]:
        return {"id": id, "name": name, "email": email, "p": float(p)}

    faculty_by_slot: Dict[str, Dict[int, Dict[str, Any]]] = {
        "mon_thu": {
            0: {
                "available": [
                    F("FAC004", "Rafael Cabrero", "rafael.cabrero@dlsu.edu.ph", 0.86),
                    F("FAC008", "Gregory Cu", "gregory.cu@dlsu.edu.ph", 0.79),
                    F("FAC016", "Justine Go", "justine.go@dlsu.edu.ph", 0.73),
                ],
                "unavailable": [
                    F("FAC010", "Neil Del Gallego", "neil.delgallego@dlsu.edu.ph", 0.22),
                    F("FAC011", "Erica De Vera", "erica.devera@dlsu.edu.ph", 0.18),
                ],
            },
            4: {
                "available": [F("FAC002", "Arnulfo Azcarraga", "arnulfo.azcarraga@dlsu.edu.ph", 0.61)],
                "unavailable": [F("FAC007", "Unisse Chu", "unisse.chu@dlsu.edu.ph", 0.31)],
            },
        },
        "tue_fri": {
            1: {
                "available": [
                    F("FAC005", "Charibeth Cheng", "charibeth.cheng@dlsu.edu.ph", 0.88),
                    F("FAC006", "Shirley Chu", "shirley.chu@dlsu.edu.ph", 0.82),
                ],
                "unavailable": [F("FAC003", "Allan Borra", "allan.borra@dlsu.edu.ph", 0.27)],
            }
        },
        "wed_sat": {
            5: {
                "available": [F("FAC004", "Rafael Cabrero", "rafael.cabrero@dlsu.edu.ph", 0.55)],
                "unavailable": [F("FAC002", "Arnulfo Azcarraga", "arnulfo.azcarraga@dlsu.edu.ph", 0.29)],
            }
        },
    }

    # Unique faculty list for combobox
    seen = {}
    faculty_opts: List[Dict[str, str]] = []
    for dp, by_idx in faculty_by_slot.items():
        for idx, detail in by_idx.items():
            for bucket in ("available", "unavailable"):
                for f in detail.get(bucket, []):
                    if f["id"] not in seen:
                        seen[f["id"]] = 1
                        faculty_opts.append({"id": f["id"], "name": f["name"], "email": f["email"]})
    faculty_opts.sort(key=lambda x: x["name"])

    return {
        "ok": True,
        "meta": {"term_label": _term_label(active)},
        "campuses": ["Manila", "Laguna"],
        "dayPairs": day_pairs,
        "timeSlots": time_slots,
        "forecast": forecast,
        "facultyBySlot": faculty_by_slot,
        "facultyOptions": faculty_opts,
        "generated_at": datetime.utcnow().isoformat() + "Z",
    }
