"""Isolated browser-test photo service with a local identity server and temp data."""
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import uvicorn
from avatar_service.photo_api import create_photo_app

JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LWFjY291bnQifQ.c2lnbmF0dXJl"


class IdentityHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        valid = self.path == "/v1/rooms/auth/me" and self.headers.get("Authorization") == "Bearer " + JWT and self.headers.get("Cookie") is None
        self.send_response(200 if valid else 401)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({
            "id": "00000000-0000-4000-8000-000000000001", "username": "photo-test",
            "role": "RECONSTRUCTOR", "disabled": False
        } if valid else {"message": "Authentication required"}).encode())

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    identity = ThreadingHTTPServer(("127.0.0.1", 0), IdentityHandler)
    thread = threading.Thread(target=identity.serve_forever, daemon=True)
    thread.start()
    os.environ["ROOM_AUTH_API_URL"] = f"http://127.0.0.1:{identity.server_port}/v1/rooms/auth/me"
    web_port = os.getenv("ROOM_WEB_TEST_PORT", "5173")
    os.environ["ROOM_BROWSER_ORIGINS"] = f"http://127.0.0.1:{web_port},http://localhost:{web_port}"
    try:
        with tempfile.TemporaryDirectory(prefix="digital-room-photo-browser-") as data:
            uvicorn.run(create_photo_app(data), host="127.0.0.1", port=int(os.getenv("ROOM_PHOTO_TEST_PORT", "8002")))
    finally:
        identity.shutdown()
        identity.server_close()
        thread.join(timeout=3)
