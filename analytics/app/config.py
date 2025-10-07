from functools import lru_cache
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # Local/dev default: same replica-set URI pattern
    mongodb_uri: str = (
        "mongodb://animo_app:local-dev-secret@mongo-primary:27017,"
        "mongo-secondary:27017/animoassign"
        "?replicaSet=animoassignRS&directConnection=false&authSource=admin"
    )
    service_name: str = "analytics"

    class Config:
        env_file = ".env"
        env_prefix = "ANALYTICS_"

@lru_cache
def get_settings() -> Settings:
    return Settings()
