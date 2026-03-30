from __future__ import annotations

from typing import Any, Dict, Iterable, Optional, Set

ACTIVE_SPECIAL_STATUSES = ("Forwarded To Department", "Approved")
REGULAR_CLASS_RETENTION_STATUSES = ("Under Review", "Approved")
DISSOLVED_CLASS_RETENTION_STATUS = "Dissolved"
CONVERT_TO_REGULAR_SPECIAL_STATUS = "Convert to Regular Class"
REJECTED_SPECIAL_STATUS = "Rejected"
DEFAULT_REGULAR_CLASS_RETENTION_STATUS = "Approved"


def normalize_status(value: Any) -> str:
    return str(value or "").strip()


def is_active_special_status(status: Any) -> bool:
    return normalize_status(status) in ACTIVE_SPECIAL_STATUSES


def is_regular_class_retention_status(status: Any) -> bool:
    return normalize_status(status) in REGULAR_CLASS_RETENTION_STATUSES


def is_dissolved_class_retention_status(status: Any) -> bool:
    return normalize_status(status).casefold() == DISSOLVED_CLASS_RETENTION_STATUS.casefold()


def remarks_has_dissolved_tag(raw_remarks: Any) -> bool:
    return any(
        part.strip().casefold() == "dissolved"
        for part in str(raw_remarks or "").split("|")
        if part and part.strip()
    )


def section_doc_is_dissolved(doc: Optional[Dict[str, Any]]) -> bool:
    row = doc or {}
    return bool(row.get("is_dissolved")) or is_dissolved_class_retention_status(row.get("class_retention_status")) or remarks_has_dissolved_tag(row.get("remarks"))


async def get_active_special_section_ids(
    db,
    term_id: str,
    *,
    special_col: str = "special_class",
    assign_col: str = "faculty_assignments",
    schedule_col: str = "section_schedules",
) -> Set[str]:
    term_id = normalize_status(term_id)
    if not term_id:
        return set()

    rows = await db.get_collection(special_col).find(
        {"term_id": term_id, "status": {"$in": list(ACTIVE_SPECIAL_STATUSES)}},
        {
            "_id": 0,
            "section_id": 1,
            "assignment_id": 1,
            "faculty_assignment_id": 1,
            "schedule_id1": 1,
            "schedule_id2": 1,
            "schedule_entries": 1,
            "slot1": 1,
            "slot2": 1,
        },
    ).to_list(None)
    if not rows:
        return set()

    section_ids: Set[str] = set()
    assignment_ids: Set[str] = set()
    schedule_ids: Set[str] = set()

    def _collect_schedule_ids(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                _collect_schedule_ids(item)
            return
        if isinstance(value, dict):
            sid = normalize_status(value.get("schedule_id") or value.get("id"))
            if sid:
                schedule_ids.add(sid)
            return
        sid = normalize_status(value)
        if sid:
            schedule_ids.add(sid)

    for row in rows:
        sid = normalize_status(row.get("section_id"))
        if sid:
            section_ids.add(sid)
        for key in ("assignment_id", "faculty_assignment_id"):
            aid = normalize_status(row.get(key))
            if aid:
                assignment_ids.add(aid)
        for key in ("schedule_id1", "schedule_id2"):
            _collect_schedule_ids(row.get(key))
        _collect_schedule_ids(row.get("schedule_entries"))
        _collect_schedule_ids(row.get("slot1"))
        _collect_schedule_ids(row.get("slot2"))

    if assignment_ids:
        docs = await db.get_collection(assign_col).find(
            {"assignment_id": {"$in": sorted(assignment_ids)}, "is_archived": {"$ne": True}},
            {"_id": 0, "section_id": 1},
        ).to_list(None)
        for doc in docs or []:
            sid = normalize_status(doc.get("section_id"))
            if sid:
                section_ids.add(sid)

    if schedule_ids:
        docs = await db.get_collection(schedule_col).find(
            {"schedule_id": {"$in": sorted(schedule_ids)}},
            {"_id": 0, "section_id": 1},
        ).to_list(None)
        for doc in docs or []:
            sid = normalize_status(doc.get("section_id"))
            if sid:
                section_ids.add(sid)

    return section_ids


async def get_dissolved_section_ids(
    db,
    term_id: str,
    *,
    section_ids: Optional[Iterable[str]] = None,
    sections_col: str = "sections",
    sections_submitted_col: str = "sections_submitted",
    class_retention_col: str = "class_retention",
) -> Set[str]:
    term_id = normalize_status(term_id)
    ids = sorted({normalize_status(s) for s in (section_ids or []) if normalize_status(s)})

    section_filter: Dict[str, Any] = {}
    if ids:
        section_filter["section_id"] = {"$in": ids}
    elif term_id:
        section_filter["term_id"] = term_id

    out: Set[str] = set()

    for col in (sections_col, sections_submitted_col):
        docs = await db.get_collection(col).find(
            section_filter,
            {"_id": 0, "section_id": 1, "remarks": 1, "is_dissolved": 1, "class_retention_status": 1},
        ).to_list(None)
        for doc in docs or []:
            sid = normalize_status(doc.get("section_id"))
            if sid and section_doc_is_dissolved(doc):
                out.add(sid)

    retention_query: Dict[str, Any] = {"status": {"$regex": r"^dissolved$", "$options": "i"}}
    if term_id:
        retention_query["term_id"] = term_id
    if ids:
        retention_query["section_id"] = {"$in": ids}

    docs = await db.get_collection(class_retention_col).find(
        retention_query,
        {"_id": 0, "section_id": 1},
    ).to_list(None)
    for doc in docs or []:
        sid = normalize_status(doc.get("section_id"))
        if sid:
            out.add(sid)

    return out
