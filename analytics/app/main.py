from fastapi import FastAPI
from motor.motor_asyncio import AsyncIOMotorClient

from .config import get_settings

app = FastAPI(title="AnimoAssign Analytics", version="1.0.0")
settings = get_settings()
client = AsyncIOMotorClient(settings.mongodb_uri)
db = client.get_default_database()


async def compute_assignment_totals():
    pipeline = [{"$group": {"_id": "$status", "count": {"$sum": 1}}}]
    return await db.assignments.aggregate(pipeline).to_list(None)


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