# backend/app/main.py
from datetime import datetime, timezone
from typing import Any, Dict

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient

from .config import get_settings

# --------------------------------------------------------------------
# Settings & App
# --------------------------------------------------------------------
settings = get_settings()
app = FastAPI(title="AnimoAssign Backend", version="1.0.0")

# --------------------------------------------------------------------
# Database (single shared client/database for all routers)
# --------------------------------------------------------------------
client = AsyncIOMotorClient(
    settings.mongodb_uri,
    # keep directConnection optional for single-node vs RS; do not force it
    directConnection=getattr(settings, "mongodb_direct_connection", False),
)
db = client.get_default_database()

__all__ = ["app", "db"]

# --------------------------------------------------------------------
# CORS (unchanged policy; adjust only if you already do elsewhere)
# --------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # keep as-is if this is what you already use
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------------------------------------------------------------
# Small helpers (safe to keep even if unused by new routes)
# --------------------------------------------------------------------
def _utcnow() -> datetime:
    return datetime.now(timezone.utc)
from typing import Optional

def _service_result(name: str, ok: bool, detail: str, latency_ms: Optional[float]) -> Dict[str, Any]:
    out: Dict[str, Any] = {"service": name, "ok": ok, "detail": detail}
    if latency_ms is not None:
        out["latencyMs"] = round(latency_ms, 2)
    return out

# --------------------------------------------------------------------
# System endpoints (keep your existing ones)
# --------------------------------------------------------------------
@app.get("/health", tags=["system"])
async def health():
    return {"status": "ok", "service": getattr(settings, "service_name", "backend")}

@app.get("/health/db", tags=["system"])
async def health_db():
    await client.admin.command("ping")
    return {"db": "ok"}

# --------------------------------------------------------------------
# Feature routers (NEW) – no path/routing changes needed
# These will live under the backend root; your nginx/Vite already forward /api/* here.
# --------------------------------------------------------------------
from .Login.Login import router as login_router
from .OM.OM_HomePage import router as om_home_router
from .OM.OM_Profile import router as om_profile_router
from .OM.OM_FacultyManagement import router as om_facultymanagement
# from .OM.OM_CourseManagement import router as om_coursemanagement
# from .OM.OM_FacultyForm import router as om_facultyform
from .OM.OM_StudentPetition import router as om_studentpetition
# from .OM.OM_ClassRentention import router as om_classretention

from .APO.APO_PreEnlistment import router as preenlistment_router
from .APO.APO_RoomAllocation import router as roomallocation_router
from .APO.APO_CourseOfferings import router as courseofferings_router
from .STUDENT.STUDENT_Petition import router as studentpetition_router
from .FACULTY.FACULTY_Overview import router as facultyoverview_router

app.include_router(login_router, prefix="/api")
app.include_router(om_home_router)
app.include_router(om_profile_router)
app.include_router(preenlistment_router, prefix="/api")
app.include_router(roomallocation_router, prefix="/api")
app.include_router(courseofferings_router, prefix="/api")
app.include_router(studentpetition_router, prefix="/api")
app.include_router(om_facultymanagement, prefix="/api")
# app.include_router(om_coursemanagement, prefix="/api")
# app.include_router(om_facultyform, prefix="/api")
app.include_router(om_studentpetition, prefix="/api")
# app.include_router(om_classretention, prefix="/api")
app.include_router(facultyoverview_router, prefix="/api")
