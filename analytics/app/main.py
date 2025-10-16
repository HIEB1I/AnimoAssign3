from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from collections import Counter
import re

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

# collections
events_col = db["analytics_events"]                  # optional event ingest
records_col = db[settings.records_collection]        # <-- MAIN collection (default: "records")

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

# ---- Root page (optional) ----
@app.get("/", response_class=HTMLResponse)
async def overview():
    return """<!doctype html>
<html><body>
  <h1>Analytics Overview</h1>
  <ul>
    <li><a href="/analytics/health">/analytics/health</a></li>
    <li><a href="/analytics/events">/analytics/events</a></li>
    <li><a href="/analytics/summary">/analytics/summary</a></li>
  </ul>
</body></html>"""

_WORD = re.compile(r"[A-Za-z0-9]+")

# ---------- THE summary YOU WANT (computed from records) ----------
@app.get("/summary")
async def summary(limit: int = 10):
    # 1) total documents in the main app collection
    total = await records_col.count_documents({})

    # 2) daily ingest (accepts createdAt OR created_at; coerces string to date)
    pipeline = [
        {"$addFields": {"ts": {"$ifNull": ["$createdAt", "$created_at"]}}},
        {"$addFields": {
            "ts": {"$cond": [
                {"$eq": [{"$type": "$ts"}, "string"]}, {"$toDate": "$ts"}, "$ts"
            ]}
        }},
        {"$group": {
            "_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$ts"}},
            "count": {"$sum": 1}
        }},
        {"$sort": {"_id": 1}},
        {"$project": {"_id": 0, "date": "$_id", "count": 1}}
    ]
    daily: List[Dict[str, Any]] = []
    async for row in records_col.aggregate(pipeline):
        daily.append(row)
    daily = daily[-limit:] if limit else daily

    # 3) top terms from `title` + `content`
    counts: Counter[str] = Counter()
    async for d in records_col.find({}, {"title": 1, "content": 1}).limit(2000):
        text = f"{(d.get('title') or '')} {(d.get('content') or '')}".lower()
        for m in _WORD.finditer(text):
            w = m.group(0)
            if len(w) < 2 or w in {"the","a","an","of","and","for","to","in","on","at","with","by","from","is","are"}:
                continue
            counts[w] += 1
    topTerms = [{"term": t, "count": c} for t, c in counts.most_common(10)]

    return {
        "totalRecords": total,
        "generatedAt": _utc_now().isoformat().replace("+00:00", "Z"),
        "topTerms": topTerms,
        "dailyIngest": daily,
    }

# ---------- Optional event ingest APIs (keep if you use them) ----------
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
        await events_col.insert_one(doc)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"store_failed: {e}")
    return {"status": "accepted"}

@app.get("/events")
async def list_events(limit: int = 100):
    cur = events_col.find({}).sort("received_at", -1).limit(limit)
    items: List[Dict[str, Any]] = []
    async for d in cur:
        d["_id"] = str(d["_id"])
        items.append(d)
    return {"items": items, "limit": limit}

@app.get("/health")
async def health():
    return {"status": "ok", "service": settings.service_name, "db": db.name, "collection": settings.records_collection}
