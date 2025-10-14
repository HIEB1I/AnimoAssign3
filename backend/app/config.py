# backend/app/config.py
from functools import lru_cache
from pydantic import Field, AliasChoices
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Mongo URI: accept either MONGODB_URI or BACKEND_MONGODB_URI
    mongodb_uri: str = Field(
        ...,
        description="MongoDB connection string",
        validation_alias=AliasChoices("MONGODB_URI", "BACKEND_MONGODB_URI"),
    )

    # Optional: allow forcing a single connection (mostly for single-node debug)
    mongodb_direct_connection: bool = Field(
        default=False,
        validation_alias=AliasChoices("MONGODB_DIRECT_CONNECTION", "BACKEND_MONGODB_DIRECT_CONNECTION"),
    )

    # Service name (used by /health)
    service_name: str = Field(
        default="backend",
        validation_alias=AliasChoices("SERVICE_NAME", "BACKEND_SERVICE_NAME"),
    )

    # Analytics base URL (POINT TO ROOT; nginx strips /analytics)
    analytics_url: str = Field(
        default="http://analytics-primary:8000",
        description="Base URL for the analytics service",
        validation_alias=AliasChoices("ANALYTICS_URL", "BACKEND_ANALYTICS_URL"),
    )

    analytics_timeout_seconds: float = Field(
        default=5.0,
        validation_alias=AliasChoices("ANALYTICS_TIMEOUT_SECONDS", "BACKEND_ANALYTICS_TIMEOUT_SECONDS"),
    )

@lru_cache
def get_settings() -> Settings:
    return Settings()
