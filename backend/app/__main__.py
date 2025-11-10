# backend/app/__main__.py
import uvicorn

if __name__ == "__main__":
    # Use the import string so the reloader can import the package cleanly.
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True, log_level="info")
