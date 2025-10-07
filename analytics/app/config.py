from functools import lru_cache
from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    mongodb_uri: str = Field(
        default="mongodb://animo_app:local-dev-secret@mongo:27017/animoassign?authSource=admin",
        description="Connection string used for MongoDB access.",
    )
    mongodb_connect_timeout_ms: int = Field(
        default=1000,
        description="Timeout in milliseconds for establishing a MongoDB connection.",
    )
    mongodb_server_selection_timeout_ms: int = Field(
        default=1000,
        description="Timeout in milliseconds for selecting a MongoDB server.",
    )
    mongodb_socket_timeout_ms: int = Field(
        default=1000,
        description="Timeout in milliseconds for MongoDB socket operations.",
    )
    service_name: str = "analytics"

    class Config:
        env_file = ".env"
        env_prefix = "ANALYTICS_"


@lru_cache
def get_settings() -> Settings:
    """Return cached analytics settings."""

    return Settings()