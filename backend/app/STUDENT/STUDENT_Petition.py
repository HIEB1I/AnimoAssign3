from datetime import datetime
from typing import Any, Dict, Optional
from fastapi import APIRouter, HTTPException, Query, Body
from ..main import db

router = APIRouter(prefix="/student", tags=["student"])

COL_USERS = "users"
COL_STUDENTS = "student_profiles"
COL_PETITIONS = "student_petitions"
COL_DEPARTMENTS = "departments"
COL_COURSES = "courses"
COL_PROGRAMS = "programs"

def _now_iso():
    return datetime.utcnow().isoformat()


@router.post("/petition")
async def petition_handler(
    userId: str = Query(..., min_length=3),
    action: str = Query("fetch", description="Action: fetch | submit | options | profile"),
    payload: Optional[Dict[str, Any]] = Body(None),
):
    """Unified student petition handler."""

    # ---------- FETCH EXISTING PETITIONS ----------
    if action == "fetch":
        student_profile = await db[COL_STUDENTS].find_one({"user_id": userId}, {"_id": 0, "student_id": 1})
        if not student_profile:
            return {"ok": False, "petitions": []}  # <-- return empty instead of 404
        docs = await db[COL_PETITIONS].find(
            {"student_id": student_profile["student_id"]}, {"_id": 0}
        ).to_list(None)
        return {"ok": True, "petitions": docs}

    # ---------- FETCH PROFILE INFO (for auto-fill) ----------
    if action == "profile":
        # Step 1: Find student profile using user_id
        student_profile = await db[COL_STUDENTS].find_one(
            {"user_id": userId},
            {"_id": 0, "student_number": 1}
        )

        if not student_profile:
            return {
                "ok": False,
                "message": "Student profile not found",
                "first_name": "",
                "last_name": "",
                "student_number": "",
            }

        # Step 2: Find user record
        user_data = await db[COL_USERS].find_one(
            {"user_id": userId},
            {"_id": 0, "first_name": 1, "last_name": 1}
        )
        print("DEBUG PROFILE:", userId, user_data, student_profile)
        # Step 3: Combine data
        return {
            "ok": True,
            "first_name": user_data.get("first_name", "") if user_data else "",
            "last_name": user_data.get("last_name", "") if user_data else "",
            "student_number": student_profile.get("student_number", ""),
        }

    # ---------- SUBMIT PETITION ----------
    if action == "submit":
        if not payload:
            raise HTTPException(status_code=400, detail="Missing payload")

        required = ["department", "courseCode", "reason"]
        if not all(k in payload and payload[k] for k in required):
            raise HTTPException(status_code=400, detail="All required fields must be filled.")

        student_profile = await db[COL_STUDENTS].find_one({"user_id": userId}, {"_id": 0})
        user_data = await db[COL_USERS].find_one({"user_id": userId}, {"_id": 0})
        if not student_profile or not user_data:
            raise HTTPException(status_code=404, detail="Student record not found")

        course_code = payload["courseCode"]
        if isinstance(course_code, list):
            course_code = course_code[0] if course_code else ""

        course_doc = await db[COL_COURSES].find_one(
            {"course_code": {"$in": [course_code]}}, {"_id": 0, "course_id": 1}
        )
        course_id = course_doc["course_id"] if course_doc else None

        petition_doc = {
            "petition_id": f"PTTN{int(datetime.utcnow().timestamp() * 1000)}",
            "student_id": student_profile["student_id"],
            "course_id": course_id,
            "term_id": payload.get("termId", "TRM0002"),
            "reason": payload["reason"],
            "remarks": "",
            "status": "PENDING",
            "submitted_at": _now_iso(),
            "first_name": user_data.get("first_name"),
            "last_name": user_data.get("last_name"),
            "student_number": student_profile.get("student_number"),
            "program_id": student_profile.get("program_id"),
            "department_id": student_profile.get("department_id"),
        }

        await db[COL_PETITIONS].insert_one(petition_doc)
        return {"ok": True, "petition": petition_doc}

    # ---------- DROPDOWN OPTIONS ----------
    if action == "options":
        # Departments
        depts = [d async for d in db[COL_DEPARTMENTS].find({}, {"_id": 0, "dept_name": 1, "department_id": 1})]

        # Courses with joined department name
        pipeline = [
            {
                "$lookup": {
                    "from": COL_DEPARTMENTS,
                    "localField": "department_id",
                    "foreignField": "department_id",
                    "as": "dept_info",
                }
            },
            {"$unwind": {"path": "$dept_info", "preserveNullAndEmptyArrays": True}},
            {
                "$project": {
                    "_id": 0,
                    "course_code": {
                        "$cond": {
                            "if": {"$isArray": "$course_code"},
                            "then": {"$arrayElemAt": ["$course_code", 0]},
                            "else": "$course_code",
                        }
                    },
                    "course_title": 1,
                    "department_id": 1,
                    "dept_name": "$dept_info.dept_name",
                }
            },
        ]
        courses = [c async for c in db[COL_COURSES].aggregate(pipeline)]

        # Programs list for dropdown
        programs = [p async for p in db[COL_PROGRAMS].find({}, {"_id": 0, "program_id": 1, "program_name": 1})]

        return {
            "ok": True,
            "departments": [d["dept_name"] for d in depts],
            "courses": courses,
            "programs": programs,
        }
    raise HTTPException(status_code=400, detail="Invalid action parameter.")
