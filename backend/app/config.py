from functools import lru_cache
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    mongodb_uri: str = (
        "mongodb://animo_app:local-dev-secret@mongo:27017/animoassign?authSource=admin"
    )
    service_name: str = "backend"
    analytics_url: str = "http://analytics:8000"
    analytics_timeout_seconds: float = 5.0

    class Config:
        env_file = ".env"
        env_prefix = "BACKEND_"


@lru_cache
def get_settings() -> Settings:
    return Settings()