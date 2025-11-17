from __future__ import annotations

from typing import Any, Dict, List, Optional
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Body, HTTPException, Query, Request
from pydantic import BaseModel, Field
from pymongo import ReturnDocument

from ..main import db  # shared Motor client from main.py

COL_PREFS_WINDOWS = "faculty_prefs_windows"
COL_TERMS = "terms"
COL_PREEN_COUNT = "preenlistment_count"
COL_LEAVES = "leaves" 


router = APIRouter(prefix="/faculty/preferences", tags=["FACULTY: Preferences"])


# ---------- Models ----------
class ModePayload(BaseModel):
    mode: Optional[str] = Field(None, description="F2F | FOL | HYB")
    campus_id: List[str] = Field(
        default_factory=list,
        description="List of campus IDs, e.g. ['CMPS0001','CMPS0002']"
    )


class DeloadingItem(BaseModel):
    deloading_type: Optional[str] = None
    units: Optional[float] = 0
    detail: Optional[str] = ""


class SubmitPayload(BaseModel):
    preferred_units: Optional[float] = 0
    availability_days: List[str] = []
    preferred_times: List[str] = []
    preferred_kacs: List[str] = [] 
    deloading_data: List[DeloadingItem] = []
    mode: Optional[ModePayload] = None
    notes: Optional[str] = None
    has_new_prep: Optional[bool] = False
    is_finished: Optional[bool] = False

    # harmless extras supported by UI
    on_break: Optional[bool] = None
    break_reason: Optional[str] = None
    break_return_date: Optional[str] = None
    employment_type: Optional[str] = None 


# ---------- Helpers ----------

async def _active_term_doc() -> dict:
    """
    Mirror the OM Faculty Form active term resolution.
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

    current = await db[COL_TERMS].find_one(
        {"$or": [{"status": "active"}, {"is_current": True}]},
        term_fields,
    )

    if not current:
        last = await db[COL_TERMS].find({}, term_fields) \
            .sort([("acad_year_start", -1), ("term_number", -1)]) \
            .limit(1).to_list(1)
        current = last[0] if last else None

    if not current:
        return {}

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
        return next_terms[0]

    return current


def _parse_date_any(dt: str | datetime | None) -> datetime | None:
  if isinstance(dt, datetime):
      return dt
  if not dt:
      return None
  try:
      return datetime.fromisoformat(str(dt).replace("Z", "+00:00"))
  except Exception:
      return None


async def _prefs_window_override_for_term(term: dict | None) -> dict:
    term = term or {}
    term_id = term.get("term_id")
    if not term_id:
        return {"openISO": "", "deadlineISO": "", "term_id": None}

    override = await db[COL_PREFS_WINDOWS].find_one(
        {"term_id": term_id},
        {
            "_id": 0,
            "open_dt": 1,
            "deadline_dt": 1,
            "openISO": 1,
            "deadlineISO": 1,
            "term_id": 1,
        },
    )

    if not override:
        return {"openISO": "", "deadlineISO": "", "term_id": term_id}

    open_dt = _parse_date_any(override.get("open_dt") or override.get("openISO"))
    deadline_dt = _parse_date_any(
        override.get("deadline_dt") or override.get("deadlineISO")
    )

    return {
        "openISO": open_dt.isoformat() if open_dt else "",
        "deadlineISO": deadline_dt.isoformat() if deadline_dt else "",
        "term_id": term_id,
    }


async def _prefs_window_for_term(term: dict) -> dict:
    term = term or {}
    term_id = term.get("term_id")

    if not term_id:
        return {
            "open_dt": None,
            "deadline_dt": None,
            "openISO": "",
            "deadlineISO": "",
            "term_id": None,
        }

    override = await db[COL_PREFS_WINDOWS].find_one(
        {"term_id": term_id},
        {
            "_id": 0,
            "open_dt": 1,
            "deadline_dt": 1,
            "openISO": 1,
            "deadlineISO": 1,
            "term_id": 1,
        },
    )

    if not override:
        return {
            "open_dt": None,
            "deadline_dt": None,
            "openISO": "",
            "deadlineISO": "",
            "term_id": term_id,
        }

    raw_open = override.get("open_dt") or override.get("openISO")
    raw_deadline = override.get("deadline_dt") or override.get("deadlineISO")

    open_dt = _parse_date_any(raw_open)
    deadline_dt = _parse_date_any(raw_deadline)

    def _ensure_utc(dt: datetime | None) -> datetime | None:
        if dt is None:
            return None
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt

    open_dt = _ensure_utc(open_dt)
    deadline_dt = _ensure_utc(deadline_dt)

    return {
        "open_dt": open_dt,
        "deadline_dt": deadline_dt,
        "openISO": open_dt.isoformat() if open_dt else "",
        "deadlineISO": deadline_dt.isoformat() if deadline_dt else "",
        "term_id": term_id,
    }

async def _get_type_id(db, type_label: str) -> str | None:
  if not type_label:
      return None
  doc = await db.deloading_types.find_one(
      {"type": {"$regex": f"^{type_label.strip()}$", "$options": "i"}},
      {"deloadingtype_id": 1},
  )
  return (doc or {}).get("deloadingtype_id")


async def _sync_deloadings(db, faculty_id: str, term_id: str, items: list[dict]) -> list[dict]:
  now = datetime.now(timezone.utc)
  normalized = []
  for r in items or []:
      t = (r.get("deloading_type") or "").strip()
      if not t:
          continue
      units_num = r.get("units", 0) or 0
      detail = (r.get("detail") or "").strip()

      needs_spec = t in ("Administrative", "Research")
      if needs_spec and not detail:
        raise HTTPException(
            status_code=400,
            detail=f'Please specify details for "{t}" (e.g., office/unit or project name).'
        )

      type_id = await _get_type_id(db, t)
      if not type_id:
          raise HTTPException(status_code=400, detail=f'Unknown deloading type: "{t}". Please create it in deloading_types.')

      normalized.append({
          "type": t,
          "type_id": type_id,
          "units": float(units_num),
          "notes": detail if needs_spec else "",
      })

  existing = await db.deloadings.find({"faculty_id": faculty_id, "term_id": term_id}).to_list(length=9999)

  def sig(row: dict) -> tuple[str, float, str]:
      return (row.get("type_id", ""), float(row.get("units_deloaded", 0)), row.get("notes", ""))

  old_sigs = {sig(x) for x in existing}
  new_sigs = {(r["type_id"], float(r["units"]), r["notes"]) for r in normalized}

  for x in existing:
      s = sig(x)
      if s not in new_sigs:
          await db.deloadings.delete_one({"_id": x["_id"]})

  for r in normalized:
      filt = {
          "faculty_id": faculty_id,
          "term_id": term_id,
          "type_id": r["type_id"],
          "units_deloaded": float(r["units"]),
          "notes": r["notes"],
      }
      await db.deloadings.update_one(
          filt,
          {
              "$setOnInsert": {
                  "deloading_id": f"DLD{now.timestamp():.0f}".replace(".", ""),
                  "approval_status": "APPROVED",
                  "created_at": now,
                  "faculty_id": faculty_id,
                  "term_id": term_id,
              },
              "$set": {
                  "updated_at": now,
              },
          },
          upsert=True,
      )

  return [
      {
          "deloading_type": r["type"],
          "units": r["units"],
          "detail": r["notes"],
      }
      for r in normalized
  ]


def _utcnow() -> datetime:
  return datetime.now(timezone.utc)


async def _faculty_profile(faculty_user_id: str) -> Dict[str, Any]:
  prof = await db.faculty_profiles.find_one({"user_id": faculty_user_id}) or {}
  user = await db.users.find_one({"user_id": faculty_user_id}) or {}
  out = {
      "user_id": faculty_user_id,
      "first_name": user.get("first_name") or prof.get("first_name"),
      "last_name": user.get("last_name") or prof.get("last_name"),
      "email": user.get("email"),
      "employment_type": prof.get("employment_type") or user.get("employment_type") or "FT",
      "department_id": prof.get("department_id") or user.get("department_id"),
  }
  return {"ok": True, "faculty": out}


async def _enrich_pref(doc: Dict[str, Any]) -> Dict[str, Any]:
  if not doc:
      return doc
  out = {**doc}
  
  # If on_break is True, we need to fetch details from 'leaves' table
  if out.get("on_break"):
      faculty_id = out.get("faculty_id")
      term_id = out.get("term_id")
      
      # Attempt to find the leave request associated with this term
      leave_doc = await db[COL_LEAVES].find_one({
          "faculty_id": faculty_id,
          "start_term_id": term_id,
          # Optionally filter by 'is_active' if that's critical, 
          # but usually the term match is enough for history
      })
      
      if leave_doc:
          out["break_reason"] = leave_doc.get("reason", "")
          out["break_return_date"] = leave_doc.get("return_date", "")
  
  mode = out.get("mode") or {}
  campus_ids = mode.get("campus_id")
  if isinstance(campus_ids, str) and campus_ids.strip():
      campus_ids = [campus_ids.strip()]
  elif not isinstance(campus_ids, list):
      campus_ids = []

  names: List[str] = []
  if campus_ids:
      cursor = db.campuses.find({"campus_id": {"$in": campus_ids}}, {"_id": 0, "campus_id": 1, "campus_name": 1})
      found = {c["campus_id"]: c.get("campus_name") for c in await cursor.to_list(length=20)}
      for cid in campus_ids:
          nm = found.get(cid)
          if nm:
              names.append(nm)

  mode["campus_id"] = campus_ids
  mode["campus_names"] = names
  out["mode"] = mode
  return out


async def _expand_kac_names(pref: Dict[str, Any]) -> Dict[str, Any]:
  if not pref or not isinstance(pref.get("preferred_kacs"), list) or not pref["preferred_kacs"]:
      return pref

  ids = [k for k in pref["preferred_kacs"] if isinstance(k, str)]
  if not ids:
      return pref

  found = {}
  cursor = db.kacs.find({"kac_id": {"$in": ids}}, {"_id": 0, "kac_id": 1, "kac_name": 1, "kac_code": 1})
  async for k in cursor:
      found[k["kac_id"]] = k

  expanded = []
  for kid in ids:
      k = found.get(kid)
      if k:
          expanded.append(k)
      else:
          expanded.append({"kac_id": kid, "kac_name": kid, "kac_code": ""})
  pref = {**pref, "preferred_kacs": expanded}
  return pref


async def _next_pref_id() -> str:
  cfg = await db.faculty_preferences.find_one_and_update(
      {"_id": "config"},
      {"$setOnInsert": {"doc_type": "config"}, "$inc": {"next_seq": 1}},
      upsert=True,
      return_document=ReturnDocument.AFTER,
  )
  seq = int((cfg or {}).get("next_seq", 1))
  return f"PREF{seq:04d}"

async def _next_leave_id() -> str:
  cfg = await db[COL_LEAVES].find_one_and_update(
      {"_id": "config"},
      {"$setOnInsert": {"doc_type": "config"}, "$inc": {"next_seq": 1}},
      upsert=True,
      return_document=ReturnDocument.AFTER,
  )
  seq = int((cfg or {}).get("next_seq", 1))
  return f"LV{seq:04d}"


# ---------- Routes ----------

@router.post("")
async def preferences_root(
  request: Request,
  action: str = Query(..., description="fetch | options | profile | submit"),
  userId: Optional[str] = Query(None, alias="userId"),
  termId: Optional[str] = Query(None, alias="termId"),
  payload: Dict[str, Any] = Body(default={}),
):
  if not userId:
      raise HTTPException(status_code=400, detail="userId is required")

  if action == "profile":
      return await _faculty_profile(userId)

  if action == "options":
      kacs: List[Dict[str, Any]] = []
      async for k in db.kacs.find({}, {"_id": 0}).limit(200):
          kacs.append(k)

      days_display = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
      time_slots_display = [
          "07:30 - 09:00", "09:15 - 10:45", "11:00 - 12:30", "12:45 - 14:15",
          "14:30 - 16:00", "16:15 - 17:45", "18:00 - 19:30", "19:45 - 21:00",
      ]

      term = await _active_term_doc()
      window = await _prefs_window_override_for_term(term)
      prefs_window = {
          "openISO": window.get("openISO") or "",
          "deadlineISO": window.get("deadlineISO") or "",
          "term_id": window.get("term_id"),
      }

      return {
          "ok": True,
          "kacs": kacs,
          "days_display": days_display,
          "time_slots_display": time_slots_display,
          "prefs_window": prefs_window,
          "activeTerm": {
              "term_id": (term or {}).get("term_id"),
          },
      }

  if action == "fetch":
      fac = await db.faculty_profiles.find_one({"user_id": userId}, {"_id": 0, "faculty_id": 1})
      if not fac:
          return {"ok": True, "preferences": []}

      q = {"faculty_id": fac["faculty_id"]}
      cursor = db.faculty_preferences.find(q, {"_id": 0}).sort([("submitted_at", -1)])
      
      prefs: List[Dict[str, Any]] = []
      async for p in cursor:
          p = await _enrich_pref(p) # This now handles fetching leave details
          p = await _expand_kac_names(p)
          prefs.append(p)
          
      return {"ok": True, "preferences": prefs}

  if action == "submit":
      if not payload:
          raise HTTPException(status_code=400, detail="Missing payload")

      fac = await db.faculty_profiles.find_one({"user_id": userId}, {"_id": 0, "faculty_id": 1})
      if not fac:
          raise HTTPException(status_code=400, detail="Faculty profile not found for user.")
      faculty_id = fac["faculty_id"]

      term_doc = await _active_term_doc()
      if not term_doc:
          raise HTTPException(status_code=400, detail="Active term not found; cannot submit preferences.")
      term_id = term_doc.get("term_id")
      if not term_id:
          raise HTTPException(status_code=400, detail="Active term not found; cannot submit preferences.")

      window = await _prefs_window_for_term(term_doc or {})
      now = _utcnow()
      open_dt = window.get("open_dt")
      deadline_dt = window.get("deadline_dt")

      if not open_dt or not deadline_dt:
          raise HTTPException(status_code=400, detail="Preference submission window has not been started.")

      if now < open_dt:
          raise HTTPException(status_code=400, detail="Preference submission window has not started yet.")

      if now > deadline_dt:
          raise HTTPException(status_code=400, detail="Preference submission deadline has passed.")

      deload_items = list(payload.get("deloading_data") or [])
      summary_deloading_data = await _sync_deloadings(db, faculty_id, term_id, deload_items)

      def _as_list_str(x: Any) -> List[str]:
          if x is None: return []
          if isinstance(x, list): return [str(v).strip() for v in x if str(v).strip()]
          if isinstance(x, str) and x.strip(): return [x.strip()]
          return []

      preferred_units = float(payload.get("preferred_units") or 0)
      availability_days = _as_list_str(payload.get("availability_days") or [])
      preferred_times = _as_list_str(payload.get("preferred_times") or [])
      preferred_kacs = _as_list_str(payload.get("preferred_kacs") or [])

      mode_in = payload.get("mode") or {}
      mode_code = str((mode_in or {}).get("mode") or "HYB").upper()
      campus_in = (mode_in or {}).get("campus_id")
      campus_ids = _as_list_str(campus_in)
      campus_ids = [c.upper() for c in campus_ids]
      if mode_code not in {"F2F", "HYB", "FOL"}:
          mode_code = "HYB"
      mode = {"mode": mode_code, "campus_id": campus_ids}

      on_break_flag = bool(payload.get("on_break", False))
      
      # --- HANDLE LEAVES LOGIC ---
      # If on_break is true, we save to 'leaves' collection and NOT in 'faculty_preferences' details
      # We still save a skeleton in faculty_preferences to mark the task as 'finished'.
      
      if on_break_flag:
          break_reason = str(payload.get("break_reason") or "").strip()
          break_return_date = str(payload.get("break_return_date") or "").strip()
          
          if not break_reason or not break_return_date:
              raise HTTPException(status_code=400, detail="Break reason and return date are required.")

          # Upsert into leaves
          existing_leave = await db[COL_LEAVES].find_one(
              {"faculty_id": faculty_id, "start_term_id": term_id}
          )
          leave_id = (existing_leave or {}).get("leave_id") or await _next_leave_id()
          
          leave_doc = {
              "leave_id": leave_id,
              "faculty_id": faculty_id,
              "approval_status": "APPROVED", # As per sample
              "is_active": True, # Or False based on your logic, assumed True for new request
              "start_term_id": term_id,
              "end_term_id": "", # Populated if we knew the exact term, simplified here
              "reason": break_reason,        # New field for the reason
              "return_date": break_return_date, # New field for the date
              "created_at": _utcnow(),
              "updated_at": _utcnow()
          }
          
          await db[COL_LEAVES].update_one(
              {"faculty_id": faculty_id, "start_term_id": term_id},
              {"$set": leave_doc},
              upsert=True
          )
          
          # Clear break details from the payload destined for faculty_preferences
          # to ensure they aren't saved there as per instruction
          payload_break_reason = "" 
          payload_break_return_date = ""
      else:
          # If NOT on break, we should probably ensure no active leave exists for this term
          # to avoid contradiction, or just ignore. 
          # For safety, let's just proceed with standard prefs.
          payload_break_reason = ""
          payload_break_return_date = ""

      if preferred_units > 0 and not on_break_flag:
          if not mode.get("mode"):
              raise HTTPException(status_code=400, detail="Preferred Delivery Mode is required.")
          if not availability_days:
              raise HTTPException(status_code=400, detail="Preferred Teaching Days are required.")
          if not preferred_times:
              raise HTTPException(status_code=400, detail="Preferred Time Slots are required.")
          if not preferred_kacs:
              raise HTTPException(status_code=400, detail="Knowledge Area Cluster (KAC) is required.")

      existing = await db.faculty_preferences.find_one(
          {"faculty_id": faculty_id, "term_id": term_id},
          {"_id": 0, "pref_id": 1},
      )
      pref_id = (existing or {}).get("pref_id") or await _next_pref_id()

      doc: Dict[str, Any] = {
          "pref_id": pref_id,
          "faculty_id": faculty_id,
          "term_id": term_id,
          "preferred_units": preferred_units,
          "availability_days": availability_days,
          "preferred_times": preferred_times,
          "preferred_kacs": preferred_kacs,
          "deloading_data": summary_deloading_data,
          "mode": mode,
          "notes": str(payload.get("notes") or ""),
          "has_new_prep": bool(payload.get("has_new_prep", False)),
          "is_finished": bool(payload.get("is_finished", False)),
          "on_break": on_break_flag,
          # These fields are now empty/unused in this table, details are in 'leaves'
          "break_reason": payload_break_reason, 
          "break_return_date": payload_break_return_date,
          "employment_type": str(payload.get("employment_type") or ""),
          "submitted_at": _utcnow(),
          "updated_at": _utcnow(),
      }

      try:
          doc_set = {**doc}
          doc_set.pop("pref_id", None)

          await db.faculty_preferences.update_one(
              {"faculty_id": faculty_id, "term_id": term_id},
              {
                  "$set": doc_set,
                  "$setOnInsert": {
                      "created_at": _utcnow(),
                      "pref_id": pref_id,
                  },
              },
              upsert=True,
          )

          saved = await db.faculty_preferences.find_one(
              {"faculty_id": faculty_id, "term_id": term_id},
              {"_id": 0}
          )
          if not saved:
              return {"ok": True, "preference": {}}
          saved = await _enrich_pref(saved)
          saved = await _expand_kac_names(saved)
          return {"ok": True, "preference": saved}
      except HTTPException:
          raise
      except Exception as e:
          raise HTTPException(status_code=400, detail=f"Failed to save preferences: {e}")

  raise HTTPException(status_code=400, detail=f"Unknown action: {action}")