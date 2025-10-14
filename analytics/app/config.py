# analytics/app/config.py
import os
from functools import lru_cache
from typing import Optional

DEFAULT_MONGODB_URI: Optional[str] = None  # keep None to force envs

def _pick_mongo_uri() -> str:
    uri = os.getenv("MONGODB_URI") or os.getenv("ANALYTICS_MONGODB_URI") or DEFAULT_MONGODB_URI
    if not uri:
        raise RuntimeError("Set MONGODB_URI or ANALYTICS_MONGODB_URI for analytics")
    return uri

class Settings:
    mongodb_uri: str = _pick_mongo_uri()
    service_name: str = os.getenv("ANALYTICS_SERVICE_NAME", "analytics")
    # optional timeouts, etc.
    request_timeout_s: float = float(os.getenv("ANALYTICS_TIMEOUT_SECONDS", "3.0"))

@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
