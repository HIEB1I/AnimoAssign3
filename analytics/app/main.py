from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field

from .db_async import fetch_teaching_history            # descriptive #1
from .db_async import get_course_profile_for            # descriptive #2
from .db_async import fetch_deloading_utilization       # descriptive #3

from .db_async import run_pt_risk                       # predictive #2

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

@app.get("/teaching-history")
async def get_teaching_history(faculty_id: str = Query(...)):
    results = await fetch_teaching_history(faculty_id)
    print("faculty_id:", faculty_id, "| documents found:", len(results))
    return {"faculty_id": faculty_id, "count": len(results), "rows": results}

@app.get("/course-profile-for")
async def course_profile_for(query: str):
    data = await get_course_profile_for(query)
    return JSONResponse(content=data)


@app.get("/deloading-utilization")
async def get_deloading_utilization(term: str | None = Query(None)):
    results = await fetch_deloading_utilization(term)
    print("term:", term, "| entries:", len(results))
    return {"term": term, "count": len(results), "rows": results}

@app.get("/analytics/pt-risk")
async def pt_risk_endpoint(
    department_id: str = Query("DEPT0001"),
    overload_allowance_units: int = Query(0, description="0 or 3"),
    history_terms_for_experience: int = Query(3),
    include_only_with_preferences: bool = Query(False),
    allow_fallback_without_sections: bool = Query(False),
):
    try:
        result = await run_pt_risk({
            "DEPT_SCOPE": department_id,
            "overload_allowance_units": overload_allowance_units,
            "history_terms_for_experience": history_terms_for_experience,
            "include_only_with_preferences": include_only_with_preferences,
            "allow_fallback_without_sections": allow_fallback_without_sections,
        })
        return result
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))