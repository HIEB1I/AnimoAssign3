# backend/app/main.py
from datetime import datetime, timezone
from typing import Any, Dict, List

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field

from .config import get_settings

settings = get_settings()

app = FastAPI(title="AnimoAssign Backend", version="1.0.0")

# Async Mongo client; directConnection may be False in RS mode, True for single-node probes
client = AsyncIOMotorClient(
    settings.mongodb_uri,
    directConnection=getattr(settings, "mongodb_direct_connection", False),
)
db = client.get_default_database()

# ---------- Models ----------

class ConnectivityTestPayload(BaseModel):
    title: str = Field(..., description="Sample title for the diagnostic record")
    status: str = Field("todo", pattern=r"^[a-zA-Z0-9_-]+$")
    notes: str | None = Field(default=None, max_length=500)

class AssignmentIn(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    content: str | None = Field(default=None, max_length=4000)

# ---------- Helpers ----------

def _utcnow() -> datetime:
    return datetime.now(timezone.utc)

def _service_result(name: str, ok: bool, detail: str, latency_ms: float | None) -> Dict[str, Any]:
    out: Dict[str, Any] = {"service": name, "ok": ok, "detail": detail}
    if latency_ms is not None:
        out["latencyMs"] = round(latency_ms, 2)
    return out

def _serialize(doc: Dict[str, Any]) -> Dict[str, Any]:
    d = dict(doc)
    d["id"] = str(d.pop("_id", ""))
    # normalize created_at
    ca = d.get("created_at")
    if isinstance(ca, datetime):
        if ca.tzinfo is None:
            ca = ca.replace(tzinfo=timezone.utc)
        d["createdAt"] = ca.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    else:
        d["createdAt"] = _utcnow().isoformat().replace("+00:00", "Z")
    return d

# ---------- CORS ----------

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

# ---------- System ----------

@app.get("/health", tags=["system"])
async def health():
    return {"status": "ok", "service": settings.service_name}

@app.get("/health/db", tags=["system"])
async def health_db():
    # simple ping to admin
    await client.admin.command("ping")
    return {"db": "ok"}

# ---------- Assignments ----------

@app.get("/assignments", tags=["assignments"])
async def list_assignments(limit: int = Query(50, ge=1, le=200)):
    cursor = db.assignments.find({}).sort("_id", -1).limit(limit)
    items: List[Dict[str, Any]] = []
    async for doc in cursor:
        items.append(_serialize(doc))
    return {"items": items, "limit": limit}

@app.post("/assignments", tags=["assignments"], status_code=201)
async def create_assignment(payload: AssignmentIn):
    document = {
        "title": payload.title.strip(),
        "content": (payload.content or "").strip(),
        "created_at": _utcnow(),
    }
    result = await db.assignments.insert_one(document)
    created = await db.assignments.find_one({"_id": result.inserted_id})
    if not created:
        raise HTTPException(status_code=500, detail="Failed to create assignment")
    return _serialize(created)

@app.get("/assignments/search", tags=["assignments"])
async def search_assignments(
    q: str = Query("", max_length=200, description="Search term for assignment titles/content"),
    limit: int = Query(25, ge=1, le=100),
):
    q = q.strip()
    filters: Dict[str, Any] = {}
    if q:
        regex = {"$regex": q, "$options": "i"}
        filters = {"$or": [{"title": regex}, {"content": regex}]}
    cursor = db.assignments.find(filters).sort("_id", -1).limit(limit)
    items: List[Dict[str, Any]] = []
    async for doc in cursor:
        items.append(_serialize(doc))
    return {"items": items, "query": q, "count": len(items)}

# ---------- Diagnostics (end-to-end) ----------

@app.post("/connectivity-test", tags=["diagnostics"])
async def connectivity_test(payload: ConnectivityTestPayload):
    results: List[Dict[str, Any]] = []
    t0 = _utcnow()

    # Backend self
    results.append(_service_result(settings.service_name, True, "Backend reached.", 0.0))

    # Mongo write/read/cleanup
    m0 = _utcnow()
    mongo_ok, mongo_detail = True, "Inserted and read diagnostic record."
    inserted_id = None
    try:
        doc = {
            "title": payload.title,
            "status": payload.status,
            "notes": payload.notes,
            "source": "connectivity-test",
            "created_at": _utcnow(),
        }
        ins = await db.connectivity_tests.insert_one(doc)
        inserted_id = ins.inserted_id
        back = await db.connectivity_tests.find_one({"_id": inserted_id})
        if back is None:
            mongo_ok = False
            mongo_detail = "Insert OK, but read-back failed."
    except Exception as e:
        mongo_ok = False
        mongo_detail = f"MongoDB error: {e}"[:300]
    finally:
        if inserted_id is not None:
            try:
                await db.connectivity_tests.delete_one({"_id": inserted_id})
            except Exception as e:
                mongo_ok = False
                extra = f"Cleanup error: {e}"[:200]
                mongo_detail = f"{mongo_detail} | {extra}"
    m_latency = (datetime.now(timezone.utc) - m0).total_seconds() * 1000
    results.append(_service_result("mongodb", mongo_ok, mongo_detail, m_latency))

    # Analytics POST (NOTE: analytics_url points to ROOT; endpoint is /ingest)
    a0 = _utcnow()
    a_ok, a_detail = True, "Analytics acknowledged event."
    try:
        async with httpx.AsyncClient(timeout=settings.analytics_timeout_seconds) as s:
            r = await s.post(
                f"{settings.analytics_url}/ingest",
                json={
                    "id": "connectivity-test",
                    "title": payload.title,
                    "created_at": _utcnow().isoformat().replace("+00:00", "Z"),
                },
            )
            r.raise_for_status()
            # optional: check returned JSON
            _ = r.json()
    except Exception as e:
        a_ok = False
        a_detail = f"Analytics error: {e}"[:300]
    a_latency = (datetime.now(timezone.utc) - a0).total_seconds() * 1000
    results.append(_service_result("analytics", a_ok, a_detail, a_latency))

    total_ms = (datetime.now(timezone.utc) - t0).total_seconds() * 1000
    return {
        "echo": payload.model_dump(),
        "services": results,
        "latencyMs": round(total_ms, 2),
        "timestamp": _utcnow().isoformat().replace("+00:00", "Z"),
    }
