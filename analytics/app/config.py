from functools import lru_cache
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    mongodb_uri: str = (
        "mongodb://animo_app:local-dev-secret@mongo:27017/animoassign?authSource=admin"
    )
    mongodb_connect_timeout_ms: int = 1000
    mongodb_server_selection_timeout_ms: int = 1000
    mongodb_socket_timeout_ms: int = 1000
    service_name: str = "analytics"

    class Config:
        env_file = ".env"
        env_prefix = "ANALYTICS_"


@lru_cache
def get_settings() -> Settings:
    return Settings()