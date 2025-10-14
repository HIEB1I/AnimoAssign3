import pytest
from httpx import AsyncClient
from motor.motor_asyncio import AsyncIOMotorClient

from app.main import app, settings


def override_db():
    client = AsyncIOMotorClient("mongodb://mongo:27017/animoassign_test")
    return client.get_default_database()


def setup_module():
    from app import main

    main.db = override_db()


@pytest.mark.asyncio
async def test_health_endpoint():
    async with AsyncClient(app=app, base_url="http://test") as client:
        response = await client.get("/health")
    assert response.status_code == 200
    assert response.json()["service"] == settings.service_name