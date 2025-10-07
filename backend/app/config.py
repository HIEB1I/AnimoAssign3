from functools import lru_cache
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # Local/dev default: service names on the same Docker network
    mongodb_uri: str = (
        "mongodb://animo_app:local-dev-secret@mongo-primary:27017,"
        "mongo-secondary:27017/animoassign"
        "?replicaSet=animoassignRS&directConnection=false&authSource=admin"
    )
    # (Keep this for legacy toggles; not needed if URI has replicaSet)
    mongodb_direct_connection: bool = False

    service_name: str = "backend"

    # Local/dev default: analytics service name on same network
    analytics_url: str = "http://analytics:8000"
    analytics_timeout_seconds: float = 5.0

    class Config:
        env_file = ".env"
        env_prefix = "BACKEND_"

@lru_cache
def get_settings() -> Settings:
    return Settings()
