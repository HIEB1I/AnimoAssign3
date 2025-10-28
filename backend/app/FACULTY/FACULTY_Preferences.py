# app/routes/faculty_preferences.py
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set
from fastapi import APIRouter, HTTPException, Query, Body
from pymongo import ReturnDocument
from ..main import db

router = APIRouter(prefix="/faculty", tags=["faculty"])

COL_USERS = "users"
COL_FACPROF = "faculty_profiles"
COL_PREFS = "faculty_preferences"
COL_TERMS = "terms"
COL_KACS = "kacs"
COL_CAMPUSES = "campuses"

TIME_BANDS = ["07:30 - 09:00", "09:15 - 10:45", "11:00 - 12:30", "12:30 - 14:15", "14:30 - 16:00", "16:15 - 17:45", "18:00 - 19:30", "19:45 - 21:00"]
DAYS = ["MTH", "TF", "WS", "SAT"]  # minimal example; adjust as needed
MODES = ["HYB", "ONL", "FTF"]

def _now_dt() -> datetime:
    return datetime.now(timezone.utc)

async def _active_term() -> Dict[str, Any]:
    t = await db[COL_TERMS].find_one(
        {"$or": [{"status": "active"}, {"is_current": True}]},
        {"_id": 0, "term_id": 1, "acad_year_start": 1, "term_number": 1},
    )
    return t or {}

async def _faculty_for_user(user_id: str) -> Optional[Dict[str, Any]]:
    return await db[COL_FACPROF].find_one({"user_id": user_id}, {"_id": 0, "faculty_id": 1, "department_id": 1})

async def _next_pref_id() -> str:
    doc = await db[COL_PREFS].find_one_and_update(
        {"_id": "config"},
        {"$setOnInsert": {"doc_type": "config"}, "$inc": {"next_seq": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    seq = int((doc or {}).get("next_seq", 1))
    return f"PREF{seq:04d}"

async def _resolve_kacs(codes_or_ids: List[str]) -> List[str]:
    """Accept either kac_id or kac_code; return list of kac_id strings."""
    if not codes_or_ids:
        return []
    q: List[Dict[str, Any]] = []
    for v in codes_or_ids:
        v = str(v).strip()
        if not v: 
            continue
        q.append({"kac_id": v})
        q.append({"kac_code": v})
    cur = db[COL_KACS].find({"$or": q}, {"_id": 0, "kac_id": 1})
    ids: Set[str] = set()
    async for row in cur:
        ids.add(row.get("kac_id"))
    return list(ids)

@router.post("/preferences")
async def preferences_handler(
    userId: str = Query(..., min_length=3),
    action: str = Query("fetch", description="fetch | options | profile | submit"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    if action == "fetch":
        fac = await _faculty_for_user(userId)
        if not fac:
            return {"ok": True, "preferences": []}

        pipeline: List[Dict[str, Any]] = [
            {"$match": {"faculty_id": fac["faculty_id"], "pref_id": {"$exists": True}}},
            # joins
            {"$lookup": {"from": COL_TERMS, "localField": "term_id", "foreignField": "term_id", "as": "term"}},
            {"$unwind": {"path": "$term", "preserveNullAndEmptyArrays": True}},
            {"$lookup": {"from": COL_KACS, "localField": "preferred_kacs", "foreignField": "kac_id", "as": "kacs"}},
            {"$lookup": {"from": COL_CAMPUSES, "localField": "mode.campus_id", "foreignField": "campus_id", "as": "camp"}},
            {"$unwind": {"path": "$camp", "preserveNullAndEmptyArrays": True}},
            {"$project": {
                "_id": 0,
                "pref_id": 1,
                "faculty_id": 1,
                "term_id": 1,
                "preferred_units": 1,
                "availability_days": 1,
                "preferred_times": 1,
                "preferred_kacs": {"$map": {"input": "$kacs", "as": "k",
                    "in": {"kac_id": "$$k.kac_id", "kac_code": "$$k.kac_code", "kac_name": "$$k.kac_name"}}},
                "mode": {"mode": "$mode.mode", "campus_id": "$mode.campus_id", "campus_name": "$camp.campus_name"},
                "notes": 1,
                "has_new_prep": 1,
                "is_finished": 1,
                "submitted_at": 1,
                "term_number": "$term.term_number",
                "acad_year_start": "$term.acad_year_start",
            }},
            {"$sort": {"submitted_at": -1}},
        ]
        rows = [r async for r in db[COL_PREFS].aggregate(pipeline)]
        return {"ok": True, "preferences": rows}

    if action == "options":
        kacs = [k async for k in db[COL_KACS].find({}, {"_id": 0, "kac_id": 1, "kac_code": 1, "kac_name": 1}).sort("kac_code", 1)]
        camps = [c async for c in db[COL_CAMPUSES].find({}, {"_id": 0, "campus_id": 1, "campus_name": 1}).sort("campus_name", 1)]
        return {"ok": True, "timeBands": TIME_BANDS, "days": DAYS, "modes": MODES, "kacs": kacs, "campuses": camps}

    if action == "profile":
        u = await db[COL_USERS].find_one({"user_id": userId}, {"_id": 0, "first_name": 1, "last_name": 1})
        fac = await _faculty_for_user(userId)
        return {
            "ok": bool(u),
            "first_name": (u or {}).get("first_name", ""),
            "last_name": (u or {}).get("last_name", ""),
            "faculty_id": (fac or {}).get("faculty_id", ""),
            "department_id": (fac or {}).get("department_id", ""),
        }

    if action == "submit":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload")

        fac = await _faculty_for_user(userId)
        if not fac:
            raise HTTPException(status_code=400, detail="Faculty profile not found for user.")

        term_id = str(payload.get("term_id") or "").strip()
        if not term_id:
            active = await _active_term()
            term_id = active.get("term_id", "")
        if not term_id:
            raise HTTPException(status_code=400, detail="Active term not found; cannot submit preferences.")

        # Required minimal fields
        try:
            preferred_units = int(payload.get("preferred_units"))
            if preferred_units < 0:
                raise ValueError()
        except Exception:
            raise HTTPException(status_code=400, detail="preferred_units must be a non-negative integer.")

        availability_days = list(payload.get("availability_days") or [])
        preferred_times = list(payload.get("preferred_times") or [])
        preferred_kacs_in = list(payload.get("preferred_kacs") or [])  # codes or ids
        has_new_prep = bool(payload.get("has_new_prep", False))
        mode_in = payload.get("mode") or {}  # {"mode": "HYB", "campus_id": "..."}
        notes = str(payload.get("notes") or "")

        kac_ids = await _resolve_kacs([str(x) for x in preferred_kacs_in])

        # Upsert unique (faculty_id, term_id)
        existing = await db[COL_PREFS].find_one({"faculty_id": fac["faculty_id"], "term_id": term_id}, {"_id": 0, "pref_id": 1})
        if existing:
            pref_id = existing["pref_id"]
        else:
            pref_id = await _next_pref_id()

        doc = {
            "pref_id": pref_id,
            "faculty_id": fac["faculty_id"],
            "term_id": term_id,
            "preferred_units": preferred_units,
            "availability_days": availability_days,
            "preferred_times": preferred_times,
            "preferred_kacs": kac_ids,
            "mode": {"mode": str(mode_in.get("mode") or "HYB"), "campus_id": str(mode_in.get("campus_id") or "")},
            "notes": notes,
            "has_new_prep": has_new_prep,
            "is_finished": bool(payload.get("is_finished", True)),
            "submitted_at": _now_dt(),
        }

        await db[COL_PREFS].update_one(
            {"faculty_id": fac["faculty_id"], "term_id": term_id},
            {"$set": doc},
            upsert=True,
        )

        # Join for display-return (include kac_name)
        kacs = [k async for k in db[COL_KACS].find(
            {"kac_id": {"$in": kac_ids}},
            {"_id": 0, "kac_id": 1, "kac_code": 1, "kac_name": 1}
        )]
        camp = None
        if doc["mode"].get("campus_id"):
            camp = await db[COL_CAMPUSES].find_one(
                {"campus_id": doc["mode"]["campus_id"]},
                {"_id": 0, "campus_name": 1}
            )
        active = await _active_term()



        return {"ok": True, "preference": {
            **doc,
            "preferred_kacs": kacs,
            "mode": {"mode": doc["mode"]["mode"], "campus_id": doc["mode"]["campus_id"], "campus_name": (camp or {}).get("campus_name", "")},
            "term_number": active.get("term_number"),
            "acad_year_start": active.get("acad_year_start"),
        }}

    raise HTTPException(status_code=400, detail="Invalid action parameter.")
