# backend/app/FACULTY/FACULTY_Preferences.py
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple, Union

from fastapi import APIRouter, Body, HTTPException, Query

from ..main import db  # shared client/db  :contentReference[oaicite:0]{index=0}

router = APIRouter(prefix="/faculty", tags=["faculty"])

# -------------------- helpers --------------------
def _utcnow() -> datetime:
    return datetime.now(timezone.utc)

async def _current_term() -> Optional[Dict[str, Any]]:
    t = await db.terms.find_one({"is_current": True}, {"_id": 0})
    if t:
        return t
    # fallback to latest AY/term (your schema)
    return await db.terms.find_one({}, {"_id": 0}, sort=[("acad_year_start", -1), ("term_number", -1)])

async def _faculty_by_user(user_id: str) -> Optional[Dict[str, Any]]:
    return await db.faculty_profiles.find_one({"user_id": user_id}, {"_id": 0})

def _ensure_mode_obj(v: Any) -> Optional[Dict[str, Any]]:
    """
    Accepts:
      - {"mode":"F2F","campus_id":"CMPS0001"}
      - [{"mode":"HYB","campus_id":"CMPS0002"}]
      - None
    Returns a single {mode, campus_id} or None.
    """
    if not v:
        return None
    if isinstance(v, list) and v:
        vv = v[0] or {}
        return {"mode": vv.get("mode"), "campus_id": vv.get("campus_id")}
    if isinstance(v, dict):
        return {"mode": v.get("mode"), "campus_id": v.get("campus_id")}
    return None

def _compress_days(ui_days: List[str]) -> List[str]:
    """UI sends full names; DB stores compressed sequences like ['MTH','TF'] (same convention used by Overview/History)."""
    day2letter = {"Monday":"M","Tuesday":"T","Wednesday":"W","Thursday":"H","Friday":"F","Saturday":"S"}
    order = ["M","T","W","H","F","S"]
    letters = sorted({day2letter.get(d, d) for d in ui_days}, key=lambda x: order.index(x) if x in order else 99)
    out: List[str] = []
    buf: List[str] = []
    def adj(a,b): return order.index(b)-order.index(a)==1
    for ch in letters:
        if not buf: buf.append(ch); continue
        if adj(buf[-1], ch): buf.append(ch)
        else: out.append("".join(buf)); buf=[ch]
    if buf: out.append("".join(buf))
    return out

async def _kac_index() -> Tuple[Dict[str, Dict[str,Any]], Dict[str, Dict[str,Any]]]:
    """returns two maps: by_id, by_code"""
    kacs = await db.kacs.find({}, {"_id": 0, "kac_id":1, "kac_code":1, "kac_name":1}).to_list(None)
    by_id  = {k["kac_id"]: k for k in kacs if k.get("kac_id")}
    by_code = {str(k.get("kac_code")): k for k in kacs if k.get("kac_code") is not None}
    return by_id, by_code

async def _deload_type_index() -> Dict[str, Dict[str,Any]]:
    types = await db.deloading_types.find({}, {"_id":0, "deloadingtype_id":1, "type":1}).to_list(None)
    return {t["deloadingtype_id"]: t for t in types if t.get("deloadingtype_id")}

async def _campus_name(campus_id: Optional[str]) -> Optional[str]:
    if not campus_id: return None
    c = await db.campuses.find_one({"campus_id": campus_id}, {"_id":0,"campus_name":1})
    return (c or {}).get("campus_name")

def _delivery_label(code: Optional[str]) -> str:
    c = (code or "").upper()
    return {"ONL":"Fully Online","F2F":"Face-to-Face Only","HYB":"Hybrid"}.get(c, "")

# -------------------- OPTIONS / PROFILE --------------------
@router.post("/preferences")
async def preferences_handler(
    userId: str = Query(..., min_length=3),
    action: str = Query("fetch", description="fetch | options | profile | submit"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    # Resolve faculty first (keeps parity with Overview/History)  :contentReference[oaicite:1]{index=1}
    faculty = await _faculty_by_user(userId)
    if not faculty:
        raise HTTPException(status_code=404, detail="Faculty not found for the given userId")

    if action == "options":
        kacs = await db.kacs.find({}, {"_id":0,"kac_id":1,"kac_code":1,"kac_name":1}).to_list(None)
        campuses = await db.campuses.find({}, {"_id":0,"campus_id":1,"campus_name":1}).to_list(None)
        dtypes = await db.deloading_types.find({}, {"_id":0,"deloadingtype_id":1,"type":1}).to_list(None)
        # simple static bands + days (kept same as Overview page behavior)  :contentReference[oaicite:2]{index=2}
        bands = ["07:30 - 09:00","09:15 - 10:45","11:00 - 12:30","12:45 - 14:15","14:30 - 16:00","16:15 - 17:45","18:00 - 19:30","19:45 - 21:00"]
        days  = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"]
        # build coursesByKac: {kac_id: [{course_id, course_code, course_title}]}
        courses_by_kac: Dict[str, List[Dict[str, Any]]] = {}
        for k in kacs:
            clist = k.get("course_list") or []
            if not clist:
                courses_by_kac[k["kac_id"]] = []
                continue
            courses = await db.courses.find(
                {"course_id": {"$in": clist}},
                {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1},
            ).to_list(None)
            # normalize course_code into a simple string where possible
            norm = []
            for c in courses:
                cc = c.get("course_code")
                norm.append({
                    "course_id": c.get("course_id"),
                    "course_code": (cc[0] if isinstance(cc, list) and cc else cc),
                    "course_title": c.get("course_title"),
                })
            courses_by_kac[k["kac_id"]] = norm

        bands = ["07:30 - 09:00","09:15 - 10:45","11:00 - 12:30","12:45 - 14:15",
                 "14:30 - 16:00","16:15 - 17:45","18:00 - 19:30","19:45 - 21:00"]
        days  = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"]

        return {
            "ok": True,
            "kacs": kacs,
            "campuses": campuses,
            "deloading_types": dtypes,
            "timeBands": bands,
            "days": days,
            "coursesByKac": courses_by_kac,
        }


    if action == "profile":
        # Minimal profile parity  :contentReference[oaicite:3]{index=3}
        user_doc = await db.users.find_one(
            {"user_id": userId},
            {"_id":0,"first_name":1,"last_name":1,"firstName":1,"lastName":1,"email":1}
        ) or {}
        first = (faculty.get("first_name") or faculty.get("firstName") or user_doc.get("first_name") or user_doc.get("firstName") or "").strip(" ,")
        last  = (faculty.get("last_name")  or faculty.get("lastName")  or user_doc.get("last_name")  or user_doc.get("lastName")  or "").strip(" ,")
        full = (f"{first} {last}".strip() or (user_doc.get("email","").split("@")[0].replace("."," ").title() if user_doc.get("email") else "Faculty"))
        return {"ok": True, "faculty": {"full_name": full, "role": "Faculty"}}

    # -------------------- FETCH (list) --------------------
    if action == "fetch":
        term = await _current_term()
        by_id, by_code = await _kac_index()
        dtype_by_id = await _deload_type_index()

        # Pull latest (by submitted_at) for this faculty (any term) but prefer current term if present
        cur = await db.faculty_preferences.find_one(
            {"faculty_id": faculty.get("faculty_id"), "term_id": (term or {}).get("term_id")},
            {"_id":0},
        )
        if not cur:
            cur = await db.faculty_preferences.find_one(
                {"faculty_id": faculty.get("faculty_id")},
                {"_id":0},
                sort=[("submitted_at", -1)],
            )

        if not cur:
            return {"ok": True, "preferences": []}

        # Normalize + enrich for UI (names not IDs)
        # preferred_kacs may be IDs, codes, or already embedded
        pk = cur.get("preferred_kacs") or []
        pk_list: List[Dict[str,Any]] = []
        for item in pk:
            if isinstance(item, dict):
                # trust existing
                d = {"kac_id": item.get("kac_id"), "kac_code": item.get("kac_code"), "kac_name": item.get("kac_name")}
            else:
                # string id or code
                s = str(item)
                d = by_id.get(s) or by_code.get(s) or {"kac_id": s, "kac_name": s}
            pk_list.append(d)

        # mode object (+ campus name)
        mode_obj = _ensure_mode_obj(cur.get("mode"))
        campus_name = await _campus_name((mode_obj or {}).get("campus_id")) if mode_obj else None

        # deloading_data -> include readable name
        dl_in = cur.get("deloading_data") or []
        dl_out: List[Dict[str,Any]] = []
        for d in dl_in:
            if not isinstance(d, dict): continue
            dtype_id = d.get("deloading_type")
            name = (dtype_by_id.get(dtype_id) or {}).get("type")
            dl_out.append({**d, "deloading_type_name": name or dtype_id})

        # preferred_courses -> enrich (if field exists)
        pcodes: List[str] = [str(x) for x in (cur.get("preferred_courses") or []) if x]
        pcourses: List[Dict[str, Any]] = []
        if pcodes:
            crs = await db.courses.find(
                {"course_id": {"$in": pcodes}},
                {"_id": 0, "course_id": 1, "course_code": 1, "course_title": 1},
            ).to_list(None)
            for c in crs:
                cc = c.get("course_code")
                pcourses.append({
                    "course_id": c.get("course_id"),
                    "course_code": (cc[0] if isinstance(cc, list) and cc else cc),
                    "course_title": c.get("course_title"),
                })
        # ...after computing pk_list, mode_obj, campus_name, dl_out, pcourses
        enriched = {
            **cur,
            "preferred_kacs": pk_list,
            "mode": ({**mode_obj, "campus_name": campus_name} if mode_obj else None),
            "deloading_data": dl_out,
            "preferred_courses": pcourses,
        }
        return {"ok": True, "preferences": [enriched]}



    # -------------------- SUBMIT (upsert) --------------------
    if action == "submit":
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="Invalid payload")

        term = await _current_term()
        if not term:
            raise HTTPException(status_code=409, detail="No active term found to attach preferences")

        # Normalize incoming fields from FE (see Faculty_Preferences.tsx submit)  :contentReference[oaicite:4]{index=4}
        preferred_units = int(payload.get("preferred_units") or 0)
        availability_days = payload.get("availability_days") or []
        preferred_times = payload.get("preferred_times") or []

        # preferred_kacs will be IDs (TS maps names->id before submit); keep as list of IDs
        preferred_kacs = [str(x) for x in (payload.get("preferred_kacs") or []) if x]
        
        # preferred_courses optional: list of course_id strings
        preferred_courses = [str(x) for x in (payload.get("preferred_courses") or []) if x]

        # mode object (expect {"mode": "F2F|ONL|HYB", "campus_id": "CMPS...."} or None)
        mode = _ensure_mode_obj(payload.get("mode")) or None

        notes = payload.get("notes") or ""
        has_new_prep = bool(payload.get("has_new_prep"))
        is_finished = bool(payload.get("is_finished"))

        # optional deloading_data [{deloading_type: DLTYPE..., units: "3"}]
        dl = []
        for d in payload.get("deloading_data") or []:
            if not isinstance(d, dict): continue
            dtype = d.get("deloading_type"); units = d.get("units")
            if dtype and units not in (None, ""):
                dl.append({"deloading_type": str(dtype), "units": str(units)})

        key = {"faculty_id": faculty.get("faculty_id"), "term_id": term.get("term_id")}
        # Keep a stable pref_id if already present; otherwise generate a simple one
        existing = await db.faculty_preferences.find_one(key, {"_id":0, "pref_id":1})
        pref_id = (existing or {}).get("pref_id") or f"PREF:{faculty.get('faculty_id')}:{term.get('term_id')}"

        update = {
            "pref_id": pref_id,
            "faculty_id": key["faculty_id"],
            "term_id": key["term_id"],
            "preferred_units": preferred_units,
            "availability_days": availability_days,   # already compressed on FE
            "preferred_times": preferred_times,
            "preferred_kacs": preferred_kacs,
            "preferred_courses": preferred_courses,
            "mode": mode,
            "deloading_data": dl,
            "notes": notes,
            "has_new_prep": has_new_prep,
            "is_finished": is_finished,
            "status": "N/A",
            "submitted_at": _utcnow().isoformat(),
        }

        await db.faculty_preferences.update_one(key, {"$set": update}, upsert=True)

        return {"ok": True, "pref_id": pref_id, "term_id": key["term_id"]}

    raise HTTPException(status_code=400, detail="Invalid action parameter")
