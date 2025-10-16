# backend/app/main.py
from datetime import datetime, timezone
from typing import Any, Dict, List

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field

from ..config import get_settings

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

