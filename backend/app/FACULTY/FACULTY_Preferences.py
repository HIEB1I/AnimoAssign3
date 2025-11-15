from __future__ import annotations

from typing import Any, Dict, List, Optional
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Body, HTTPException, Query, Request
from pydantic import BaseModel, Field
from pymongo import ReturnDocument

from ..main import db  # shared Motor client from main.py

router = APIRouter(prefix="/faculty/preferences", tags=["FACULTY: Preferences"])


# ---------- Models ----------
class ModePayload(BaseModel):
    # Allowed: "F2F" (if you ever use), "FOL" (fully online), "HYB" (hybrid)
    mode: Optional[str] = Field(None, description="F2F | FOL | HYB")
    campus_id: List[str] = Field(
        default_factory=list,
        description="List of campus IDs, e.g. ['CMPS0001','CMPS0002']"
    )


class DeloadingItem(BaseModel):
    deloading_type: Optional[str] = None
    units: Optional[float] = 0
    # optional free-text detail (UI calls it `detail`)
    detail: Optional[str] = ""


class SubmitPayload(BaseModel):
    preferred_units: Optional[float] = 0
    availability_days: List[str] = []           # e.g., ["MW", "H", "F"]
    preferred_times: List[str] = []             # e.g., ["0915-1045"]
    preferred_kacs: List[str] = []              # IDs or codes
    deloading_data: List[DeloadingItem] = []
    mode: Optional[ModePayload] = None
    notes: Optional[str] = None
    has_new_prep: Optional[bool] = False
    is_finished: Optional[bool] = False

    # harmless extras supported by UI
    on_break: Optional[bool] = None
    break_reason: Optional[str] = None
    break_return_date: Optional[str] = None
    employment_type: Optional[str] = None  # FT | PT


class PrefDoc(SubmitPayload):
    faculty_id: str
    term_id: Optional[str] = None
    submitted_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


from datetime import datetime, timezone, timedelta


async def _active_term_doc() -> dict | None:
  term = await db.terms.find_one(
      {"$or": [{"status": "active"}, {"is_current": True}]},
      {"_id": 0, "term_id": 1, "start_date": 1, "classes_start_date": 1}
  )
  return term or {}


def _parse_date_any(dt: str | datetime | None) -> datetime | None:
  if isinstance(dt, datetime):
      return dt
  if not dt:
      return None
  try:
      return datetime.fromisoformat(str(dt).replace("Z", "+00:00"))
  except Exception:
      return None


def _prefs_window_from_term(term: dict) -> tuple[datetime, datetime]:
  """
  Opens at the start of WEEK 7 of the current term,
  then closes exactly 30 days after open.
  """
  start = _parse_date_any(term.get("classes_start_date")) or _parse_date_any(term.get("start_date")) or datetime.now(timezone.utc)
  if start.tzinfo is None:
      start = start.replace(tzinfo=timezone.utc)

  open_dt = start + timedelta(weeks=6)  # week 7
  close_dt = open_dt + timedelta(days=30)

  return open_dt, close_dt


async def _get_type_id(db, type_label: str) -> str | None:
  if not type_label:
      return None
  doc = await db.deloading_types.find_one(
      {"type": {"$regex": f"^{type_label.strip()}$", "$options": "i"}},
      {"deloadingtype_id": 1},
  )
  return (doc or {}).get("deloadingtype_id")


async def _sync_deloadings(db, faculty_id: str, term_id: str, items: list[dict]) -> list[dict]:
  """
  Canonical write to `deloadings` and return a lightweight summary for faculty_preferences.deloading_data.
  Each item is expected to have: { deloading_type: str, units: number, detail?: str }
  Rules:
    - If type is Administrative or Research -> detail is required and saved to `notes`
    - Other types -> notes can be empty
  """
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


async def _active_term_id() -> Optional[str]:
  doc = await db.terms.find_one({
      "$or": [{"status": "active"}, {"is_current": True}]
  }, {"_id": 0, "term_id": 1})
  return (doc or {}).get("term_id")


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


async def _faculty_for_user(user_id: str) -> dict | None:
  return await db.faculty_profiles.find_one(
      {"user_id": user_id},
      {"_id": 0, "faculty_id": 1, "department_id": 1},
  )


async def _next_pref_id() -> str:
  cfg = await db.faculty_preferences.find_one_and_update(
      {"_id": "config"},
      {"$setOnInsert": {"doc_type": "config"}, "$inc": {"next_seq": 1}},
      upsert=True,
      return_document=ReturnDocument.AFTER,
  )
  seq = int((cfg or {}).get("next_seq", 1))
  return f"PREF{seq:04d}"


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
      kacs = []
      async for k in db.kacs.find({}, {"_id": 0}).limit(200):
          kacs.append(k)

      days_display = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
      time_slots_display = [
          "07:30 - 09:00", "09:15 - 10:45", "11:00 - 12:30", "12:45 - 14:15",
          "14:30 - 16:00", "16:15 - 17:45", "18:00 - 19:30", "19:45 - 21:00",
      ]
      term = await _active_term_doc()
      open_dt, close_dt = _prefs_window_from_term(term)
      return {
          "ok": True,
          "kacs": kacs,
          "days_display": days_display,
          "time_slots_display": time_slots_display,
          "prefs_window": {
              "openISO": open_dt.isoformat(),
              "deadlineISO": close_dt.isoformat(),
              "term_id": term.get("term_id")
          }}

  if action == "fetch":
      fac = await db.faculty_profiles.find_one({"user_id": userId}, {"_id": 0, "faculty_id": 1})
      if not fac:
          return {"ok": True, "preferences": []}

      tid = termId or await _active_term_id()
      q = {"faculty_id": fac["faculty_id"]}
      if tid:
          q["term_id"] = tid

      cursor = db.faculty_preferences.find(q, {"_id": 0}).sort([("submitted_at", -1)])
      prefs: List[Dict[str, Any]] = []
      async for p in cursor:
          p = await _enrich_pref(p)
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
      term_id = termId or term_doc.get("term_id")
      if not term_id:
          raise HTTPException(status_code=400, detail="Active term not found; cannot submit preferences.")

      deload_items = list(payload.get("deloading_data") or [])
      summary_deloading_data = await _sync_deloadings(db, faculty_id, term_id, deload_items)

      def _as_list_str(x: Any) -> List[str]:
          if x is None:
              return []
          if isinstance(x, list):
              return [str(v).strip() for v in x if str(v).strip()]
          if isinstance(x, str) and x.strip():
              return [x.strip()]
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

      if preferred_units > 0 and not on_break_flag:
          if not mode.get("mode"):
              raise HTTPException(
                  status_code=400,
                  detail="Preferred Delivery Mode is required when you have a teaching load.",
              )
          if not availability_days:
              raise HTTPException(
                  status_code=400,
                  detail="Preferred Teaching Days are required when you have a teaching load.",
              )
          if not preferred_times:
              raise HTTPException(
                  status_code=400,
                  detail="Preferred Time Slots are required when you have a teaching load.",
              )
          if not preferred_kacs:
              raise HTTPException(
                  status_code=400,
                  detail="Knowledge Area Cluster (KAC) is required when you have a teaching load.",
              )

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
          "on_break": bool(payload.get("on_break", False)),
          "break_reason": str(payload.get("break_reason") or ""),
          "break_return_date": str(payload.get("break_return_date") or ""),
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
