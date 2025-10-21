# analytics/app/main.py
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
import os
import re
from collections import Counter

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field

from .config import get_settings

settings = get_settings()
app = FastAPI(title="AnimoAssign Analytics", version="1.0.0")

client = AsyncIOMotorClient(settings.mongodb_uri)
db = client.get_default_database()

# ---- Which collection should analytics read from?
# default to "assignments" for your staging; override with env if needed
SOURCE_COLLECTION = os.getenv("ANALYTICS_SOURCE_COLLECTION", "assignments")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

def _utc_now() -> datetime:
    return datetime.now(timezone.utc)

class IngestEvent(BaseModel):
    id: Optional[str] = None
    title: str = Field(..., min_length=1, max_length=200)
    created_at: Optional[str] = None  # ISO8601 from backend

@app.get("/", response_class=HTMLResponse)
async def overview():
    return """<!doctype html>
<html><body>
  <h1>Analytics Overview</h1>
  <p>Insights computed by the analytics service.</p>
  <ul>
    <li><a href="/analytics/health">/analytics/health</a></li>
    <li><a href="/analytics/events">/analytics/events</a></li>
    <li><a href="/analytics/summary">/analytics/summary</a></li>
  </ul>
</body></html>"""

_WORD = re.compile(r"[A-Za-z0-9]+")

@app.get("/summary")
async def summary(limit: int = 10):
    """
    Computes cards from SOURCE_COLLECTION (default: 'assignments'):
      - totalRecords: count of docs
      - dailyIngest: per-day counts using created_at (string or date)
      - topTerms: top tokens from recent titles
    """
    coll = db[SOURCE_COLLECTION]

    # 1) total
    total = await coll.count_documents({})

    # 2) daily ingest (created_at may be string or Date → $toDate is safe)
    pipeline = [
        {
            "$group": {
                "_id": {
                    "$dateToString": {
                        "format": "%Y-%m-%d",
                        "date": {"$toDate": "$created_at"},
                    }
                },
                "count": {"$sum": 1},
            }
        },
        {"$sort": {"_id": -1}},
        {"$limit": 30},
    ]
    daily: List[Dict[str, Any]] = []
    async for row in coll.aggregate(pipeline):
        daily.append({"date": row["_id"], "count": row["count"]})
    daily = list(reversed(daily))  # oldest → newest

    # 3) top terms from recent titles
    recent_cursor = coll.find({}, projection={"title": 1, "created_at": 1}) \
                        .sort("created_at", -1).limit(200)

    counts: Counter[str] = Counter()
    async for d in recent_cursor:
        title = (d.get("title") or "").lower()
        for m in _WORD.finditer(title):
            w = m.group(0)
            if len(w) < 2:
                continue
            if w in {"the","a","an","of","and","for","to","in","on","at","with","by","from","is","are"}:
                continue
            counts[w] += 1
    topTerms = [{"term": t, "count": c} for t, c in counts.most_common(10)]

    return {
        "totalRecords": int(total),
        "generatedAt": _utc_now().isoformat().replace("+00:00", "Z"),
        "topTerms": topTerms,
        "dailyIngest": daily[-limit:] if limit else daily,
    }

@app.get("/health")
async def health():
    return {"status": "ok", "service": settings.service_name, "source": SOURCE_COLLECTION}

@app.get("/health/db")
async def health_db():
    await client.admin.command("ping")
    return {"db": "ok"}

# Kept for compatibility if backend ever posts events, but unused for your cards
@app.post("/ingest", status_code=202)
async def ingest(payload: IngestEvent):
    doc: Dict[str, Any] = {
        "id": payload.id,
        "title": payload.title.strip(),
        "created_at": payload.created_at or _utc_now().isoformat().replace("+00:00", "Z"),
        "received_at": _utc_now(),
        "kind": "record_created",
    }
    try:
        await db["analytics_events"].insert_one(doc)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"store_failed: {e}")
    return {"status": "accepted"}

@app.get("/events")
async def list_events(limit: int = 100):
    cur = db["analytics_events"].find({}).sort("received_at", -1).limit(limit)
    items: List[Dict[str, Any]] = []
    async for d in cur:
        d["_id"] = str(d["_id"])
        items.append(d)
    return {"items": items, "limit": limit}
