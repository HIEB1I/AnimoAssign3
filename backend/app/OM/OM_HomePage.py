# backend/app/OM/OM_HomePage.py
from fastapi import APIRouter, Query
from ..main import db  # reuse db

router = APIRouter(prefix="/om", tags=["om"])

@router.get("/home")
async def om_home(userId: str = Query(..., min_length=3)):
    # simple tiles using seeded collections  :contentReference[oaicite:1]{index=1}
    notif_count = await db["notifications"].count_documents({"user_id": userId})
    role_count  = await db["user_roles"].count_documents({"user_id": userId})
    courses     = await db["courses"].count_documents({})
    sections    = await db["sections"].count_documents({})

    return {
        "userId": userId,
        "cards": {
            "notifications": notif_count,
            "myRoles": role_count,
            "totalCourses": courses,
            "totalSections": sections,
        }
    }
