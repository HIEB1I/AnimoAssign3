# Expose FastAPI instance so "uvicorn app:app" works.
from .main import app, db  # if you want db available as app.db
__all__ = ["app", "db"]
