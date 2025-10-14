import re
from collections.abc import AsyncIterator
from typing import Any, Dict, List

import pytest
import pytest_asyncio
from httpx import AsyncClient

from app.main import app, settings

TEST_BASE_URL = "http://localhost"


class InsertOneResult:
    def __init__(self, inserted_id: str):
        self.inserted_id = inserted_id


class InMemoryCursor:
    def __init__(self, items: List[Dict[str, Any]]):
        self._items = list(items)
        self._iter: AsyncIterator[Dict[str, Any]] | None = None

    def sort(self, key: str, direction: int):
        reverse = direction < 0
        self._items.sort(key=lambda item: item.get(key), reverse=reverse)
        return self

    def limit(self, count: int):
        if count >= 0:
            self._items = self._items[:count]
        return self

    def __aiter__(self):
        self._iter = iter(self._items)
        return self

    async def __anext__(self):
        assert self._iter is not None
        try:
            return next(self._iter)
        except StopIteration as exc:  # pragma: no cover - iterator protocol
            raise StopAsyncIteration from exc


class InMemoryCollection:
    def __init__(self):
        self._data: List[Dict[str, Any]] = []
        self._counter = 0

    async def insert_one(self, document: Dict[str, Any]):
        self._counter += 1
        stored = dict(document)
        stored["_id"] = str(self._counter)
        self._data.append(stored)
        return InsertOneResult(stored["_id"])

    async def find_one(self, filters: Dict[str, Any]):
        identifier = filters.get("_id")
        for item in self._data:
            if item.get("_id") == identifier:
                return dict(item)
        return None

    def find(self, filters: Dict[str, Any]):
        if not filters:
            candidates = list(self._data)
        else:
            candidates = [doc for doc in self._data if _match_filters(doc, filters)]
        return InMemoryCursor(candidates)

    async def delete_many(self, _filters: Dict[str, Any]):
        self._data.clear()


def _match_filters(document: Dict[str, Any], filters: Dict[str, Any]) -> bool:
    if "$or" in filters:
        for clause in filters["$or"]:
            field, pattern = next(iter(clause.items()))
            value = str(document.get(field, ""))
            regex = pattern.get("$regex", "")
            if re.search(regex, value, re.IGNORECASE):
                return True
        return False
    return True


class InMemoryDatabase:
    def __init__(self):
        self.records = InMemoryCollection()


@pytest_asyncio.fixture(autouse=True)
async def use_inmemory_database(monkeypatch):
    from app import main

    main.db = InMemoryDatabase()

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(main, "_notify_analytics", _noop)
    yield
    await main.db.records.delete_many({})


def _headers() -> Dict[str, str]:
    return {"host": "localhost"}


@pytest.mark.asyncio
async def test_health_endpoint():
    async with AsyncClient(app=app, base_url=TEST_BASE_URL) as client:
        response = await client.get("/health", headers=_headers())
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == settings.service_name


@pytest.mark.asyncio
async def test_create_and_list_records():
    payload = {"title": "Service Integration", "content": "Testing connectivity across services."}

    async with AsyncClient(app=app, base_url=TEST_BASE_URL) as client:
        create_response = await client.post("/records", json=payload, headers=_headers())
    assert create_response.status_code == 201
    created = create_response.json()
    assert created["title"] == payload["title"]
    assert created["content"] == payload["content"]
    assert "id" in created

    async with AsyncClient(app=app, base_url=TEST_BASE_URL) as client:
        list_response = await client.get("/records", headers=_headers())
    assert list_response.status_code == 200
    items = list_response.json()["items"]
    assert len(items) == 1
    assert items[0]["title"] == payload["title"]


@pytest.mark.asyncio
async def test_search_records():
    records = [
        {"title": "First Deployment", "content": "Launched service S1"},
        {"title": "Second Deployment", "content": "Launched service S2"},
        {"title": "Analytics Update", "content": "Improved reporting"},
    ]

    async with AsyncClient(app=app, base_url=TEST_BASE_URL) as client:
        for record in records:
            response = await client.post("/records", json=record, headers=_headers())
            assert response.status_code == 201

    async with AsyncClient(app=app, base_url=TEST_BASE_URL) as client:
        search_response = await client.get("/records/search", params={"q": "service"}, headers=_headers())
    assert search_response.status_code == 200
    payload = search_response.json()
    assert payload["count"] == 2
    titles = {item["title"] for item in payload["items"]}
    assert "First Deployment" in titles
    assert "Second Deployment" in titles