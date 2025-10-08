from functools import lru_cache
from pydantic import Field, AliasChoices
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    # load .env if present; ignore unknown envs cleanly
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Require a URI; accept either MONGODB_URI or BACKEND_MONGODB_URI
    mongodb_uri: str = Field(
        ...,
        description="MongoDB connection string",
        validation_alias=AliasChoices("MONGODB_URI", "BACKEND_MONGODB_URI"),
    )

    # Accept both SERVICE_NAME and BACKEND_SERVICE_NAME
    service_name: str = Field(
        default="backend",
        validation_alias=AliasChoices("SERVICE_NAME", "BACKEND_SERVICE_NAME"),
    )

    # Accept both ANALYTICS_URL and BACKEND_ANALYTICS_URL
    analytics_url: str = Field(
        default="http://analytics-primary:8000/analytics",
        description="Base URL for the analytics service",
        validation_alias=AliasChoices("ANALYTICS_URL", "BACKEND_ANALYTICS_URL"),
    )

    # Accept both ANALYTICS_TIMEOUT_SECONDS and BACKEND_ANALYTICS_TIMEOUT_SECONDS
    analytics_timeout_seconds: float = Field(
        default=5.0,
        validation_alias=AliasChoices(
            "ANALYTICS_TIMEOUT_SECONDS", "BACKEND_ANALYTICS_TIMEOUT_SECONDS"
        ),
    )

@lru_cache
def get_settings() -> Settings:
    return Settings()