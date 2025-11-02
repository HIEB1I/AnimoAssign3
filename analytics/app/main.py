# analytics/app/main.py
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
from .OM_REPORTS_ANALYTICS.OM_RP_FacultyTeachingHistory import router as om_rp_teachhist_router
from .OM_REPORTS_ANALYTICS.OM_RP_CourseHistory import router as om_rp_coursehist_router
from .OM_REPORTS_ANALYTICS.OM_RP_DeloadingUtilization import router as om_rp_deload_router
from .OM_REPORTS_ANALYTICS.OM_RP_AvailabilityForecasting import router as om_rp_avail_router
from .OM_REPORTS_ANALYTICS.OM_RP_LoadRisk import router as om_rp_loadrisk_router
from .OM_REPORTS_ANALYTICS.OM_RP_FacultyTeachingHistory import router as rp_fac_hist_router

app.include_router(om_rp_teachhist_router, prefix="/api")
app.include_router(om_rp_coursehist_router, prefix="/api")
app.include_router(om_rp_deload_router, prefix="/api")
app.include_router(om_rp_avail_router, prefix="/api")
app.include_router(om_rp_loadrisk_router, prefix="/api")
app.include_router(rp_fac_hist_router)
