from datetime import datetime, timezone
from typing import Any, Dict, List

from fastapi import FastAPI, HTTPException, Query
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field

from .config import get_settings

app = FastAPI(title="AnimoAssign Analytics", version="1.0.0")
settings = get_settings()
client = AsyncIOMotorClient(settings.mongodb_uri)
db = client.get_default_database()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class RecordIngestEvent(BaseModel):
    id: str = Field(..., description="Identifier of the ingested record")
    title: str = Field(..., description="Title of the record")
    created_at: datetime = Field(default_factory=_utc_now)


@app.get("/health")
async def health():
    return {"status": "ok", "service": settings.service_name}


@app.get("/analytics/summary")
async def analytics_summary(top_limit: int = Query(5, ge=1, le=25)):
    total_records = await db.records.count_documents({})

    top_terms_pipeline: List[Dict[str, Any]] = [
        {"$unwind": "$terms"},
        {"$group": {"_id": "$terms", "count": {"$sum": 1}}},
        {"$sort": {"count": -1, "_id": 1}},
        {"$limit": top_limit},
    ]
    top_terms_cursor = db.records.aggregate(top_terms_pipeline)
    top_terms: List[Dict[str, Any]] = []
    async for row in top_terms_cursor:
        top_terms.append({"term": row.get("_id"), "count": int(row.get("count", 0))})

    daily_pipeline: List[Dict[str, Any]] = [
        {
            "$group": {
                "_id": {
                    "$dateToString": {
                        "format": "%Y-%m-%d",
                        "date": "$created_at",
                    }
                },
                "count": {"$sum": 1},
            }
        },
        {"$sort": {"_id": 1}},
    ]
    daily_cursor = db.records.aggregate(daily_pipeline)
    daily_ingest: List[Dict[str, Any]] = []
    async for row in daily_cursor:
        daily_ingest.append({"date": row.get("_id"), "count": int(row.get("count", 0))})

    return {
        "generatedAt": _iso_timestamp(_utc_now()),
        "service": settings.service_name,
        "totalRecords": total_records,
        "topTerms": top_terms,
        "dailyIngest": daily_ingest,
    }


@app.post("/analytics/ingest")
async def record_ingest(event: RecordIngestEvent):
    document = event.model_dump()
    document["received_at"] = _utc_now()
    try:
        await db.analytics_events.insert_one(document)
    except Exception as exc:  # pragma: no cover - guard
        raise HTTPException(status_code=500, detail=f"Failed to record ingest event: {exc}")
    return {"ok": True, "service": settings.service_name}
