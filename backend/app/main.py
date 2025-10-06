from datetime import datetime
from typing import Any, Dict, List

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field

from .config import get_settings

app = FastAPI(title="AnimoAssign Backend", version="1.0.0")
settings = get_settings()
client = AsyncIOMotorClient(settings.mongodb_uri)
db = client.get_default_database()


class ConnectivityTestPayload(BaseModel):
    """Payload sent from the frontend when running a connectivity check."""

    title: str = Field(..., description="Sample title used when inserting a test record")
    status: str = Field(
        "todo",
        description="Assignment status used for the test record",
        pattern="^[a-zA-Z0-9_-]+$",
    )
    notes: str | None = Field(
        default=None,
        description="Optional notes to store alongside the test record",
        max_length=500,
    )


def _service_result(
    name: str,
    ok: bool,
    detail: str,
    latency_ms: float | None,
) -> Dict[str, Any]:
    """Utility to construct a service response payload."""

    payload: Dict[str, Any] = {
        "service": name,
        "ok": ok,
        "detail": detail,
    }
    if latency_ms is not None:
        payload["latencyMs"] = round(latency_ms, 2)
    return payload

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", tags=["system"])
async def health_check():
    return {"status": "ok", "service": settings.service_name}


@app.get("/assignments", tags=["assignments"])
async def list_assignments():
    assignments = []
    async for doc in db.assignments.find():
        doc["_id"] = str(doc["_id"])
        assignments.append(doc)
    return {"items": assignments}


@app.post("/assignments", tags=["assignments"], status_code=201)
async def create_assignment(payload: dict):
    result = await db.assignments.insert_one(payload)
    created = await db.assignments.find_one({"_id": result.inserted_id})
    if created is None:
        raise HTTPException(status_code=500, detail="Failed to create assignment")
    created["_id"] = str(created["_id"])
    return created


@app.get("/assignments/search", tags=["assignments"])
async def search_assignments(
    q: str = Query("", max_length=200, description="Search term for assignment titles"),
    limit: int = Query(
        25,
        ge=1,
        le=100,
        description="Maximum number of assignments to return",
    ),
):
    filters: Dict[str, Any] = {}
    search_term = q.strip()
    if search_term:
        filters["title"] = {"$regex": search_term, "$options": "i"}

    cursor = (
        db.assignments.find(filters)
        .sort("_id", -1)
        .limit(limit)
    )

    results: List[Dict[str, Any]] = []
    async for doc in cursor:
        doc["_id"] = str(doc["_id"])
        results.append(doc)

    return {"items": results, "query": q, "count": len(results)}


@app.post("/connectivity-test", tags=["diagnostics"])
async def run_connectivity_test(payload: ConnectivityTestPayload):
    """Run a workflow that ensures each dependent service is reachable."""

    results: List[Dict[str, Any]] = []

    backend_start = datetime.now()
    results.append(
        _service_result(
            name=settings.service_name,
            ok=True,
            detail="Backend received the diagnostic payload.",
            latency_ms=0.0,
        )
    )

    mongo_start = datetime.now()
    mongo_status = True
    mongo_detail = "Inserted and read diagnostic record successfully."
    inserted_id = None
    try:
        document = {
            "title": payload.title,
            "status": payload.status,
            "notes": payload.notes,
            "source": "connectivity-test",
            "created_at": datetime.utcnow(),
        }
        result = await db.connectivity_tests.insert_one(document)
        inserted_id = result.inserted_id
        fetched = await db.connectivity_tests.find_one({"_id": inserted_id})
        if fetched is None:
            mongo_status = False
            mongo_detail = "Inserted diagnostic record but could not read it back."
    except Exception as exc:  # pragma: no cover - defensive logging
        mongo_status = False
        mongo_detail = f"MongoDB error: {exc}"[:300]
    finally:
        if inserted_id is not None:
            try:
                await db.connectivity_tests.delete_one({"_id": inserted_id})
            except Exception as cleanup_exc:  # pragma: no cover - defensive guard
                mongo_status = False
                cleanup_message = f"MongoDB cleanup error: {cleanup_exc}"[:300]
                if "error" in mongo_detail.lower():
                    mongo_detail = f"{mongo_detail} | {cleanup_message}"
                else:
                    mongo_detail = cleanup_message

    mongo_latency = (datetime.now() - mongo_start).total_seconds() * 1000
    results.append(
        _service_result(
            name="mongodb",
            ok=mongo_status,
            detail=mongo_detail,
            latency_ms=mongo_latency,
        )
    )

    analytics_start = datetime.now()
    analytics_status = True
    analytics_detail = "Analytics acknowledged the diagnostic event."
    try:
        async with httpx.AsyncClient(timeout=settings.analytics_timeout_seconds) as client:
            response = await client.post(
                f"{settings.analytics_url}/analytics/test-event",
                json={
                    "title": payload.title,
                    "status": payload.status,
                    "notes": payload.notes,
                    "source": "connectivity-test",
                },
            )
            response.raise_for_status()
            body = response.json()
            analytics_status = bool(body.get("ok", True))
            analytics_detail = body.get(
                "detail",
                "Analytics service responded successfully.",
            )
    except Exception as exc:  # pragma: no cover - defensive logging
        analytics_status = False
        analytics_detail = f"Analytics error: {exc}"[:300]

    analytics_latency = (datetime.now() - analytics_start).total_seconds() * 1000
    results.append(
        _service_result(
            name="analytics",
            ok=analytics_status,
            detail=analytics_detail,
            latency_ms=analytics_latency,
        )
    )

    overall_latency = (datetime.now() - backend_start).total_seconds() * 1000
    return {
        "echo": payload.model_dump(),
        "services": results,
        "latencyMs": round(overall_latency, 2),
        "timestamp": datetime.utcnow().isoformat() + "Z",
    }