from __future__ import annotations

from typing import Optional

import httpx
from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, EmailStr, Field

router = APIRouter(tags=["Google Calendar"])

BASE = "https://www.googleapis.com/calendar/v3"

class InviteEventReq(BaseModel):
    recipient: EmailStr
    summary: str = Field(min_length=1, max_length=200)
    start: str  # ISO dateTime
    end: str    # ISO dateTime
    description: str = ""

    # repetition
    repeat_every_days: int = 0  # 0 = no repeat
    repeat_count: int = 1       # total occurrences (only used if repeat_every_days > 0)
    
def extract_token(authorization: Optional[str]) -> str:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization.split(" ", 1)[1].strip()
    raise HTTPException(status_code=401, detail="Missing Authorization: Bearer <token>.")


@router.get("/gcal/calendars")
async def list_calendars(authorization: Optional[str] = Header(default=None)):
    token = extract_token(authorization)

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(f"{BASE}/users/me/calendarList", headers={"Authorization": f"Bearer {token}"})

    if r.status_code == 401:
        raise HTTPException(status_code=401, detail="Token invalid/expired. Reconnect Google.")
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text)
    return r.json()


@router.get("/gcal/events")
async def list_events(
    calendarId: str = Query(...),
    timeMin: str = Query(...),
    timeMax: str = Query(...),
    authorization: Optional[str] = Header(default=None),
):
    token = extract_token(authorization)

    params = {
        "timeMin": timeMin,
        "timeMax": timeMax,
        "singleEvents": "true",
        "orderBy": "startTime",
        "maxResults": 2500,
    }

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(
            f"{BASE}/calendars/{httpx.URL(calendarId).raw_path.decode('utf-8')}/events",
            params=params,
            headers={"Authorization": f"Bearer {token}"},
        )

    if r.status_code == 401:
        raise HTTPException(status_code=401, detail="Token invalid/expired. Reconnect Google.")
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text)
    return r.json()


class CreateEventReq(BaseModel):
    calendarId: str
    summary: str = Field(min_length=1)
    start: str  # ISO dateTime
    end: str    # ISO dateTime
    description: str = ""


@router.post("/gcal/create")
async def create_event(payload: CreateEventReq, authorization: Optional[str] = Header(default=None)):
    token = extract_token(authorization)
    body = {
        "summary": payload.summary,
        "description": payload.description,
        "start": {"dateTime": payload.start},
        "end": {"dateTime": payload.end},
    }

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(
            f"{BASE}/calendars/{payload.calendarId}/events",
            headers={"Authorization": f"Bearer {token}"},
            json=body,
        )

    if r.status_code == 401:
        raise HTTPException(status_code=401, detail="Token invalid/expired. Reconnect Google.")
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text)
    return r.json()


class DeleteEventReq(BaseModel):
    calendarId: str
    eventId: str


@router.post("/gcal/delete")
async def delete_event(payload: DeleteEventReq, authorization: Optional[str] = Header(default=None)):
    token = extract_token(authorization)

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.delete(
            f"{BASE}/calendars/{payload.calendarId}/events/{payload.eventId}",
            headers={"Authorization": f"Bearer {token}"},
        )

    if r.status_code == 401:
        raise HTTPException(status_code=401, detail="Token invalid/expired. Reconnect Google.")
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text)
    return {"ok": True}


class CopyReq(BaseModel):
    sourceCalendarId: str
    destCalendarId: str
    eventId: str


@router.post("/gcal/copy")
async def copy_event(payload: CopyReq, authorization: Optional[str] = Header(default=None)):
    token = extract_token(authorization)

    async with httpx.AsyncClient(timeout=20) as client:
        # fetch source event
        r1 = await client.get(
          f"{BASE}/calendars/{payload.sourceCalendarId}/events/{payload.eventId}",
          headers={"Authorization": f"Bearer {token}"},
        )
        if r1.status_code >= 400:
            raise HTTPException(status_code=r1.status_code, detail=r1.text)

        ev = r1.json()
        # strip fields that cannot be inserted as-is
        ev.pop("id", None)
        ev.pop("etag", None)
        ev.pop("htmlLink", None)
        ev.pop("created", None)
        ev.pop("updated", None)
        ev.pop("iCalUID", None)

        # insert into destination
        r2 = await client.post(
          f"{BASE}/calendars/{payload.destCalendarId}/events",
          headers={"Authorization": f"Bearer {token}"},
          json=ev,
        )
        if r2.status_code >= 400:
            raise HTTPException(status_code=r2.status_code, detail=r2.text)

    return r2.json()

@router.post("/gcal/invite")
async def invite_event(payload: InviteEventReq, authorization: Optional[str] = Header(default=None)):
    token = extract_token(authorization)

    body = {
        "summary": payload.summary,
        "description": payload.description,
        "start": {"dateTime": payload.start},
        "end": {"dateTime": payload.end},
        "attendees": [{"email": payload.recipient}],
    }

    # RRULE repetition (daily interval)
    if payload.repeat_every_days and payload.repeat_every_days > 0:
        interval = payload.repeat_every_days
        count = max(1, payload.repeat_count)
        body["recurrence"] = [f"RRULE:FREQ=DAILY;INTERVAL={interval};COUNT={count}"]

    # sendUpdates=all ensures Google emails the recipient
    url = f"{BASE}/calendars/primary/events"
    params = {"sendUpdates": "all"}

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post(
            url,
            params=params,
            headers={"Authorization": f"Bearer {token}"},
            json=body,
        )

    if r.status_code == 401:
        raise HTTPException(status_code=401, detail="Token invalid/expired. Reconnect Google.")
    if r.status_code == 403:
        # Most common: missing calendar scopes
        raise HTTPException(status_code=403, detail=r.text)
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text)

    return r.json()