from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient

from .config import get_settings

app = FastAPI(title="AnimoAssign Backend", version="1.0.0")
settings = get_settings()
client = AsyncIOMotorClient(settings.mongodb_uri)
db = client.get_default_database()

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