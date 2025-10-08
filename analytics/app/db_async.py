import os
from functools import lru_cache
from motor.motor_asyncio import AsyncIOMotorClient
from .config import get_settings

@lru_cache(maxsize=1)
def get_client() -> AsyncIOMotorClient:
    return AsyncIOMotorClient(get_settings().mongodb_uri)

def get_db():
    return get_client().get_default_database()  # db from URI path
