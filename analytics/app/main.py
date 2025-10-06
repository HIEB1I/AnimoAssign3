from datetime import datetime

from fastapi import FastAPI, HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field

from .config import get_settings

app = FastAPI(title="AnimoAssign Analytics", version="1.0.0")
settings = get_settings()
client = AsyncIOMotorClient(settings.mongodb_uri)
db = client.get_default_database()


STATUS_LABELS = {
    "todo": "To do",
    "in_progress": "In progress",
    "done": "Done",
}


async def compute_assignment_totals():
    pipeline = [{"$group": {"_id": "$status", "count": {"$sum": 1}}}]
    return await db.assignments.aggregate(pipeline).to_list(None)


class AnalyticsTestEvent(BaseModel):
    title: str = Field(..., description="Title associated with the diagnostic payload")
    status: str = Field(..., description="Assignment status provided by the diagnostic")
    notes: str | None = Field(None, description="Optional notes supplied with the payload")
    source: str | None = Field(None, description="Origin of the diagnostic payload")


@app.get("/health")
async def health():
    return {"status": "ok", "service": settings.service_name}


@app.get("/analytics/assignment-totals")
async def get_assignment_totals():
    results = await compute_assignment_totals()
    await db.analytics_status.replace_one(
        {"_id": "assignment_totals"},
        {"_id": "assignment_totals", "results": results},
        upsert=True,
    )
    return {"results": results}


@app.post("/analytics/test-event")
async def receive_test_event(event: AnalyticsTestEvent):
    document = event.model_dump()
    document["created_at"] = datetime.utcnow()
    try:
        result = await db.analytics_events.insert_one(document)
    except Exception as exc:  # pragma: no cover - defensive guard
        raise HTTPException(status_code=500, detail=f"Failed to record test event: {exc}")

    return {
        "ok": True,
        "detail": "Test event stored in analytics datastore.",
        "id": str(result.inserted_id),
        "service": settings.service_name,
    }


@app.get("/analytics/summary")
async def analytics_summary():
    totals = await compute_assignment_totals()
    total_assignments = sum(int(row.get("count", 0)) for row in totals)

    breakdown = []
    for row in totals:
        status = row.get("_id", "unknown")
        count = int(row.get("count", 0))
        label = STATUS_LABELS.get(status, status.replace("_", " ").title())
        percentage = (count / total_assignments * 100) if total_assignments else 0.0
        breakdown.append(
            {
                "status": status,
                "label": label,
                "count": count,
                "percentage": round(percentage, 2),
            }
        )

    diagnostics_count = await db.analytics_events.count_documents({})

    return {
        "generatedAt": datetime.utcnow().isoformat() + "Z",
        "totalAssignments": total_assignments,
        "diagnosticEventsStored": diagnostics_count,
        "statusBreakdown": breakdown,
        "service": settings.service_name,
    }