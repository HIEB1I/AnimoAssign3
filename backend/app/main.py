from datetime import datetime, timezone
import re
from typing import Any, Dict, List

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field

from .config import get_settings

from collections import Counter
import re

app = FastAPI(title="AnimoAssign Records Backend", version="1.0.0")
settings = get_settings()
client = AsyncIOMotorClient(settings.mongodb_uri)
db = client.get_default_database()

TERM_PATTERN = re.compile(r"[a-zA-Z0-9]+")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _created_at_iso(value: Any) -> str:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


def _extract_terms(*values: str) -> List[str]:
    terms: List[str] = []
    for value in values:
        if not value:
            continue
        terms.extend(match.group(0).lower() for match in TERM_PATTERN.finditer(value))
    return terms


def _serialize_record(document: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": str(document.get("_id")),
        "title": document.get("title", ""),
        "content": document.get("content", ""),
        "createdAt": _created_at_iso(document.get("created_at", _utc_now())),
    }


class RecordCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    content: str = Field(..., min_length=1, max_length=4000)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


_WORD = re.compile(r"[A-Za-z0-9]+")

@app.get("/summary")
async def summary(limit: int = 10):
    # 1) total records (events ingested)
    total = await db.analytics_events.count_documents({})

    # 2) daily ingest counts (YYYY-MM-DD)
    pipeline = [
        {
            "$group": {
                "_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$received_at"}},
                "count": {"$sum": 1},
            }
        },
        {"$sort": {"_id": -1}},
        {"$limit": 30},
    ]
    daily: list[dict] = []
    async for row in db.analytics_events.aggregate(pipeline):
        daily.append({"date": row["_id"], "count": row["count"]})
    daily = list(reversed(daily))  # oldest → newest

    # 3) top terms (simple tokenization of recent titles)
    #    (Adjust window if you like)
    recent_cursor = db.analytics_events.find(
        {}, projection={"title": 1}
    ).sort("received_at", -1).limit(200)

    counts: Counter[str] = Counter()
    async for ev in recent_cursor:
        title = (ev.get("title") or "").lower()
        for m in _WORD.finditer(title):
            w = m.group(0)
            if len(w) < 2:
                continue
            if w in {"the","a","an","of","and","for","to","in","on","at","with","by","from","is","are"}:
                continue
            counts[w] += 1

    topTerms = [{"term": t, "count": c} for t, c in counts.most_common(10)]

    return {
        "totalRecords": total,
        "generatedAt": _utc_now().isoformat().replace("+00:00", "Z"),
        "topTerms": topTerms,
        "dailyIngest": daily[-limit:] if limit else daily,
    }
    
@app.get("/health", tags=["system"])
async def health_check():
    return {"status": "ok", "service": settings.service_name}


@app.get("/records", tags=["records"])
async def list_records(limit: int = Query(20, ge=1, le=100)):
    cursor = db.records.find({}).sort("created_at", -1).limit(limit)
    records: List[Dict[str, Any]] = []
    async for document in cursor:
        records.append(_serialize_record(document))
    return {"items": records, "limit": limit}


async def _notify_analytics(document: Dict[str, Any]) -> None:
    payload = {
        "id": str(document.get("_id")),
        "title": document.get("title"),
        "created_at": _created_at_iso(document.get("created_at", _utc_now())),
    }
    try:
        async with httpx.AsyncClient(timeout=settings.analytics_timeout_seconds) as client_session:
            await client_session.post(f"{settings.analytics_url}/ingest", json=payload)
    except Exception:
        # Best effort notification – analytics service unavailability should not block writes.
        pass


@app.post("/records", tags=["records"], status_code=201)
async def create_record(payload: RecordCreate):
    document = {
        "title": payload.title.strip(),
        "content": payload.content.strip(),
        "created_at": _utc_now(),
        "terms": _extract_terms(payload.title, payload.content),
    }
    result = await db.records.insert_one(document)
    created = await db.records.find_one({"_id": result.inserted_id})
    if created is None:
        raise HTTPException(status_code=500, detail="Failed to create record")

    await _notify_analytics(created)

    return _serialize_record(created)


@app.get("/records/search", tags=["records"])
async def search_records(
    q: str = Query("", max_length=200, description="Search query for record titles or content"),
    limit: int = Query(20, ge=1, le=100, description="Maximum number of records to return"),
):
    search_term = q.strip()
    filters: Dict[str, Any] = {}
    if search_term:
        regex = {"$regex": search_term, "$options": "i"}
        filters = {"$or": [{"title": regex}, {"content": regex}]}

    cursor = db.records.find(filters).sort("created_at", -1).limit(limit)
    results: List[Dict[str, Any]] = []
    async for document in cursor:
        results.append(_serialize_record(document))

    return {"items": results, "query": search_term, "count": len(results)}