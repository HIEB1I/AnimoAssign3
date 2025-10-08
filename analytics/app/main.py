from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

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

# ---- Root pages/APIs (Nginx strips /analytics → these root routes) ----

@app.get("/", response_class=HTMLResponse)
async def overview():
    return """<!doctype html>
<html><body>
  <h1>Analytics Overview</h1>
  <p>Insights computed by the analytics service.</p>
  <ul>
    <li><a href="/health">/health</a></li>
    <li><a href="/events">/events</a></li>
    <li><a href="/summary">/summary</a></li>
  </ul>
</body></html>"""

@app.get("/health")
async def health():
    return {"status": "ok", "service": settings.service_name}

@app.get("/health/db")
async def health_db():
    await client.admin.command("ping")
    return {"db": "ok"}

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
        await db.analytics_events.insert_one(doc)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"store_failed: {e}")
    return {"status": "accepted"}

@app.get("/events")
async def list_events(limit: int = 100):
    cur = db.analytics_events.find({}).sort("received_at", -1).limit(limit)
    items: List[Dict[str, Any]] = []
    async for d in cur:
        d["_id"] = str(d["_id"])
        items.append(d)
    return {"items": items, "limit": limit}

@app.get("/summary")
async def summary(limit: int = 10):
    cur = db.analytics_events.find({}).sort("received_at", -1).limit(limit)
    latest: List[Dict[str, Any]] = []
    async for d in cur:
        d["_id"] = str(d["_id"])
        latest.append(d)
    total = await db.analytics_events.count_documents({})
    return {"total": total, "latest": latest, "limit": limit}