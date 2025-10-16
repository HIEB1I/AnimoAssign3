# analytics/app/config.py
from functools import lru_cache
from pydantic import BaseSettings, Field

class Settings(BaseSettings):
    # Accept either MONGODB_URI or ANALYTICS_MONGODB_URI
    mongodb_uri: str = Field("", env="MONGODB_URI")
    analytics_mongodb_uri: str = Field("", env="ANALYTICS_MONGODB_URI")

    service_name: str = Field("analytics", env="ANALYTICS_SERVICE_NAME")
    records_collection: str = Field("records", env="RECORDS_COLLECTION")
    request_timeout_s: float = Field(3.0, env="ANALYTICS_TIMEOUT_SECONDS")

    @property
    def mongo_uri(self) -> str:
        # prefer MONGODB_URI, fallback to ANALYTICS_MONGODB_URI
        return self.mongodb_uri or self.analytics_mongodb_uri

    model_config = {"extra": "ignore"}  # ignore unknown envs safely

@lru_cache(maxsize=1)
def get_settings() -> Settings:
    s = Settings()
    if not s.mongo_uri:
        raise RuntimeError("Set MONGODB_URI or ANALYTICS_MONGODB_URI for analytics")
    return s
