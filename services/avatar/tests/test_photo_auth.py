import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi import HTTPException
from avatar_service.photo_api import resolve_account

JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl"


@pytest.fixture
def identity_server(monkeypatch):
    state = {"status": 200, "body": {"id": str(uuid.uuid4()), "username": "alice", "role": "RECONSTRUCTOR", "disabled": False}, "cookies": [], "authorization": []}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state["cookies"].append(self.headers.get("Cookie"))
            state["authorization"].append(self.headers.get("Authorization"))
            self.send_response(state["status"])
            self.end_headers()
            self.wfile.write(json.dumps(state["body"]).encode())

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("ROOM_AUTH_API_URL", f"http://127.0.0.1:{server.server_port}/v1/rooms/auth/me")
    yield state
    server.shutdown()
    server.server_close()
    thread.join(timeout=3)


def test_jwt_is_validated_by_central_api_with_only_bearer_authorization(identity_server):
    account = resolve_account(JWT)
    assert account["id"] == identity_server["body"]["id"]
    assert identity_server["authorization"] == ["Bearer " + JWT]
    assert identity_server["cookies"] == [None]


@pytest.mark.parametrize("status,expected", [(401, 401), (403, 401), (500, 503)])
def test_central_rejection_and_failure_never_grant_access(identity_server, status, expected):
    identity_server["status"] = status
    with pytest.raises(HTTPException) as error:
        resolve_account(JWT)
    assert error.value.status_code == expected


@pytest.mark.parametrize("body", [
    {"id": "../../other", "role": "ADMIN", "disabled": False},
    {"id": str(uuid.uuid4()), "role": "ADMIN", "disabled": True},
    {"id": str(uuid.uuid4()), "role": "UNKNOWN", "disabled": False},
    {"id": str(uuid.uuid4()), "role": "ADMIN"},
])
def test_invalid_account_response_fails_closed(identity_server, body):
    identity_server["body"] = body
    with pytest.raises(HTTPException):
        resolve_account(JWT)


@pytest.mark.parametrize("token", [
    "", "a" * 43, "a.b", "a.b.c.d", ".b.c", "a..c", "a.b.",
    "a.b.c=", "a.b.c\r\nX-Role: ADMIN", "a." + "b" * 8189 + ".c", None,
])
def test_invalid_jwt_is_rejected_without_contacting_identity_service(identity_server, token):
    with pytest.raises(HTTPException) as error:
        resolve_account(token)
    assert error.value.status_code == 401
    assert identity_server["cookies"] == []
    assert identity_server["authorization"] == []


def test_maximum_size_compact_jwt_is_forwarded_for_central_validation(identity_server):
    token = "a." + "b" * 8188 + ".c"
    assert resolve_account(token)["id"] == identity_server["body"]["id"]
    assert identity_server["authorization"] == ["Bearer " + token]
