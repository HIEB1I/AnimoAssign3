# backend/app/main.py
from datetime import datetime, timezone
from typing import Any, Dict, Optional

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


@app.on_event("startup")
async def _ensure_faculty_overview_indexes() -> None:
    # lookups / filters
    await db.faculty_profiles.create_index("user_id")
    await db.faculty_assignments.create_index([("faculty_id", 1), ("is_archived", 1)])
    await db.sections.create_index([("section_id", 1), ("term_id", 1)])
    await db.section_schedules.create_index("section_id")
    await db.rooms.create_index([("room_id", 1), ("campus_id", 1)])
    await db.campuses.create_index("campus_id")
    await db.courses.create_index("course_id")
    await db.terms.create_index([("acad_year_start", -1), ("term_number", -1)])
    await db.departments.create_index("department_id")
    # summary header lookup
    await db.faculty_loads.create_index([("department_id", 1), ("term_id", 1)])

    # ------------------------------------------------------
    # FACULTY: PREFERENCES (pattern: fast fetch + unique scope)
    # ------------------------------------------------------
    await db.faculty_preferences.create_index([("faculty_id", 1), ("term_id", 1)], unique=True)
    await db.faculty_preferences.create_index([("submitted_at", -1)])  # recency sort

    # Lookups used by router
    await db.kacs.create_index("kac_id")
    await db.kacs.create_index("kac_code")
    await db.campuses.create_index("campus_id")  # already present above; safe if duplicated
    await db.terms.create_index([("acad_year_start", -1), ("term_number", -1)])  # already present

    # OM: LOAD ASSIGNMENT – lookups & sorts
    await db.faculty_assignments.create_index([("section_id", 1)])
    await db.faculty_assignments.create_index([("faculty_id", 1)])
    await db.faculty_assignments.create_index([("created_at", -1)])
    await db.sections.create_index([("section_id", 1)])
    await db.section_schedules.create_index([("section_id", 1), ("start_time", 1)])
    await db.courses.create_index([("course_id", 1)])
    await db.users.create_index([("user_id", 1)])

    # ------------------------------------------------------
    # ADMIN: MANAGEMENT – lookups & recency sort
    # (added per request; idempotent if run multiple times)
    # ------------------------------------------------------
    await db.users.create_index("user_id")  # already created above; safe duplicate
    await db.users.create_index("email")
    await db.user_roles.create_index("role_id")
    await db.user_roles.create_index("role_type")
    await db.role_assignments.create_index("user_id")
    await db.departments.create_index("department_id")  # already created above; safe duplicate
    await db.departments.create_index("dept_code")
    await db.audit_logs.create_index([("timestamp", -1)])


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

from .OM.OM_Inbox import router as om_inbox_router
from .OM.OM_LoadAssignment import router as om_loadassignment_router

from .APO.APO_PreEnlistment import router as preenlistment_router
from .APO.APO_RoomAllocation import router as roomallocation_router

from .STUDENT.STUDENT_Petition import router as studentpetition_router

from .FACULTY.FACULTY_Overview import router as facultyoverview_router
from .FACULTY.FACULTY_Preferences import router as faculty_prefs_router
from .FACULTY.FACULTY_History import router as faculty_history_router
from .FACULTY.FACULTY_Inbox import router as faculty_inbox_router

from .ADMIN.ADMIN import router as admin_router
from .ADMIN.ADMIN_Inbox import router as admin_inbox_router

app.include_router(login_router, prefix="/api")

app.include_router(om_inbox_router)
app.include_router(om_loadassignment_router, prefix="/api")

app.include_router(preenlistment_router, prefix="/api")
app.include_router(roomallocation_router, prefix="/api")
app.include_router(studentpetition_router, prefix="/api")

app.include_router(facultyoverview_router, prefix="/api")
app.include_router(faculty_prefs_router, prefix="/api")
app.include_router(faculty_history_router, prefix="/api")
app.include_router(faculty_inbox_router, prefix="/api")

app.include_router(admin_router, prefix="/api")
app.include_router(admin_inbox_router, prefix="/api")
