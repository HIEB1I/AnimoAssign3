# backend/app/db.py
import os
from functools import lru_cache
from typing import Optional
from pymongo import MongoClient

# Optional: a sane emergency fallback (can be left as None to force env-only)
DEFAULT_URI: Optional[str] = None
# e.g.:
# DEFAULT_URI = "mongodb://animo_app:DLSU1234!@10.1.11.16:27017,10.1.11.17:27017/animoassign?replicaSet=animoassignRS&authSource=admin&retryWrites=true&w=majority"

def _pick_uri() -> str:
    uri = os.getenv("MONGODB_URI") or os.getenv("BACKEND_MONGODB_URI") or DEFAULT_URI
    if not uri:
        raise RuntimeError("No Mongo URI found in MONGODB_URI or BACKEND_MONGODB_URI")
    return uri

@lru_cache(maxsize=1)
def get_client() -> MongoClient:
    """Singleton client for the process."""
    uri = _pick_uri()
    return MongoClient(uri)

def get_db():
    """Database selected by the URI path (e.g., /animoassign)."""
    return get_client().get_database()

def get_collection(name: str):
    return get_db()[name]
