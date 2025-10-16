from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field

from collections import Counter
import re

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

