from functools import lru_cache
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    mongodb_uri: str = (
        "mongodb://animo_app:DLSU1234%21@10.1.11.16:27017/animoassign?directConnection=true&authSource=admin"
    )
    service_name: str = "analytics"

    class Config:
        env_file = ".env"
        env_prefix = "ANALYTICS_"


@lru_cache
def get_settings() -> Settings:
    return Settings()