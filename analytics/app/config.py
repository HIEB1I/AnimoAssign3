from functools import lru_cache
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    mongodb_uri: str = (
        "mongodb://animo_app:DLSU1234!@localhost:27018/animoassign?authSource=admin&directConnection=true"
    )
    service_name: str = "analytics"

    class Config:
        env_file = ".env"
        env_prefix = "ANALYTICS_"


@lru_cache
def get_settings() -> Settings:
    return Settings()