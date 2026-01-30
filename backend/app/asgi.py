# backend/app/asgi.py
import socketio

from .main import app as fastapi_app
from .REALTIME.sio_server import sio

# Serve Socket.IO on /api/socket.io while keeping FastAPI routes working
app = socketio.ASGIApp(
    sio,
    other_asgi_app=fastapi_app,
    socketio_path="api/socket.io",
)
