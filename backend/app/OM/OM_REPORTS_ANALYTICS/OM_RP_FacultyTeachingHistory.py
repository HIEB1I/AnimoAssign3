# backend/app/OM/OM-RP_FacultyTeachingHistory.py
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Query
from datetime import datetime
from ...main import db

router = APIRouter(prefix="/analytics", tags=["analytics"])

COL_USERS = "users"
COL_FACULTY = "faculty_profiles"
COL_ASSIGN = "faculty_assignments"
COL_SECTIONS = "sections"
COL_SCHED = "section_schedules"
COL_COURSES = "courses"
COL_TERMS = "terms"
COL_CAMPUSES = "campuses"

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
  if not ay or not tn:
    return ""
  return f"AY {ay}-{int(ay)+1} T{tn}"

@router.get("/teaching-history")
async def teaching_history(faculty_id: Optional[str] = Query(None)) -> Dict[str, Any]:
  """
  Returns teaching history rows (optionally filtered by faculty_id) plus a simple faculty picker list.
  Shape is friendly to the OM Reports UI.
  """
  active = await _active_term()

  # faculty options
  fac_pipeline = [
      {"$lookup": {"from": COL_USERS, "localField": "user_id", "foreignField": "user_id", "as": "u"}},
      {"$unwind": {"path": "$u", "preserveNullAndEmptyArrays": True}},
      {"$project": {
          "_id": 0,
          "faculty_id": 1,
          "faculty_name": {
              "$trim": { "input": {
                  "$concat": [
                      {"$ifNull": ["$u.first_name", ""]},
                      {"$cond": [{"$and":[{"$ne":["$u.first_name", None]},{"$ne":["$u.last_name", None]}]}, " ", ""]},
                      {"$ifNull": ["$u.last_name", ""]},
                  ]
              }}
          },
      }},
      {"$match": {"faculty_name": {"$ne": ""}}},
      {"$sort": {"faculty_name": 1}},
  ]
  faculty_opts = [x async for x in db[COL_FACULTY].aggregate(fac_pipeline)]

  # main rows
  match_stage: Dict[str, Any] = {}
  if faculty_id:
    match_stage["faculty_id"] = faculty_id

  pipeline: List[Dict[str, Any]] = [
      {"$match": match_stage} if match_stage else {"$match": {}},
      {"$lookup": {"from": COL_SECTIONS, "localField": "section_id", "foreignField": "section_id", "as": "sec"}},
      {"$unwind": {"path": "$sec", "preserveNullAndEmptyArrays": True}},
      {"$lookup": {"from": COL_SCHED, "localField": "section_id", "foreignField": "section_id", "as": "scheds"}},
      {"$lookup": {"from": COL_COURSES, "localField": "sec.course_id", "foreignField": "course_id", "as": "course"}},
      {"$unwind": {"path": "$course", "preserveNullAndEmptyArrays": True}},
      {"$lookup": {"from": COL_FACULTY, "localField": "faculty_id", "foreignField": "faculty_id", "as": "fac"}},
      {"$unwind": {"path": "$fac", "preserveNullAndEmptyArrays": True}},
      {"$lookup": {"from": COL_USERS, "localField": "fac.user_id", "foreignField": "user_id", "as": "u"}},
      {"$unwind": {"path": "$u", "preserveNullAndEmptyArrays": True}},
      {"$addFields": {
          "course_code_display": {
              "$cond": [
                  {"$isArray": "$course.course_code"},
                  {"$ifNull": [{"$arrayElemAt": ["$course.course_code", 0]}, ""]},
                  {"$ifNull": ["$course.course_code", ""]},
              ]
          },
          "faculty_name_display": {
              "$trim": { "input": {
                  "$concat": [
                      {"$ifNull": ["$u.first_name", ""]},
                      {"$cond": [{"$and":[{"$ne":["$u.first_name", None]},{"$ne":["$u.last_name", None]}]}, " ", ""]},
                      {"$ifNull": ["$u.last_name", ""]},
                  ]
              }}
          },
      }},
      {"$sort": {"_id": -1}},
      {"$limit": 500},
  ]

  def collapse_sched(scheds: List[Dict[str, Any]]) -> Dict[str, str]:
    # Combine up to two meetings in "M 07:30–09:00; H 07:30–09:00" format
    parts: List[str] = []
    for s in (scheds or [])[:2]:
      day = s.get("day") or ""
      st = str(s.get("start_time") or "")
      et = str(s.get("end_time") or "")
      def fmt(x: str) -> str:
        x = x.strip()
        if not x or len(x) not in (3,4): return ""
        hh = x[:-2]
        mm = x[-2:]
        return f"{int(hh)}:{mm}"
      if day and st and et:
        parts.append(f"{day} {fmt(st)}–{fmt(et)}")
    room = ""
    if scheds:
      s0 = scheds[0]
      rt = (s0.get("room_type") or "").strip()
      room = rt if rt in ("Online", "TBA") else (s0.get("room_id") or "")
    return {"day_time": "; ".join([p for p in parts if p]) or "", "room_label": room}

  rows: List[Dict[str, Any]] = []
  async for it in db[COL_ASSIGN].aggregate(pipeline):
    scheds = it.get("scheds") or []
    collapsed = collapse_sched(scheds)
    # term display: try section.term_id -> lookup terms
    term: Optional[Dict[str, Any]] = None
    if it.get("sec", {}).get("term_id"):
      term = await db[COL_TERMS].find_one({"term_id": it["sec"]["term_id"]}, {"_id": 0, "acad_year_start": 1, "term_number": 1})
    rows.append({
      "faculty_id": it.get("faculty_id") or "",
      "faculty_name": it.get("faculty_name_display") or "",
      "term_label": _term_label(term or {}),
      "course_code": it.get("course_code_display") or "",
      "course_title": (it.get("course") or {}).get("course_title", "") or "",
      "section_code": (it.get("sec") or {}).get("section_code", "") or "",
      "campus_name": (it.get("sec") or {}).get("campus_name", "") or "",
      **collapsed,
      "created_at": it.get("created_at").isoformat() if isinstance(it.get("created_at"), datetime) else None,
    })

  return {
      "ok": True,
      "meta": { "term_label": _term_label(active) },
      "faculty": faculty_opts,
      "rows": rows,
  }
