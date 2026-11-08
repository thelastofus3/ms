import io
import uuid

import pytest

from fastapi.testclient import TestClient
from PIL import Image

ORIGIN = {"Origin": "http://127.0.0.1:5173"}
ALICE = str(uuid.uuid4())
BOB = str(uuid.uuid4())
TOKENS = {
    "a": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl",
    "b": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJib2IifQ.c2lnbmF0dXJl",
    "s": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSIsInZlciI6Mn0.c2lnbmF0dXJl",
}


@pytest.fixture(autouse=True)
def account_service(monkeypatch):
    from avatar_service import photo_api

    def resolve(token):
        from fastapi import HTTPException
        users = {
            TOKENS["a"]: (ALICE, "RECONSTRUCTOR"),
            TOKENS["b"]: (BOB, "RECONSTRUCTOR"),
            TOKENS["s"]: (ALICE, "SPLAT_UPLOADER"),
        }
        if token not in users:
            raise HTTPException(401, "Authentication required")
        identity, role = users[token]
        return {"id": identity, "username": "test", "role": role, "disabled": False}

    monkeypatch.setattr(photo_api, "resolve_account", resolve, raising=False)


def client_for(app, token="a"):
    client = TestClient(app, headers=ORIGIN)
    client.cookies.set("room_access_token", TOKENS[token])
    return client


def photo():
    data = io.BytesIO()
    Image.new("RGB", (128, 256), "red").save(data, "PNG")
    return ("person.png", data.getvalue(), "image/png")


def test_upload_envelope_is_bounded_before_multipart(tmp_path):
    from avatar_service.photo_api import create_photo_app

    client = client_for(create_photo_app(tmp_path))
    response = client.post(
        "/v1/photo-captures",
        content=b"x",
        headers={"Content-Length": str(102 * 1024 * 1024)},
    )
    assert response.status_code == 413


def test_photo_capture_is_private_persistent_and_not_a_fake_avatar(tmp_path):
    from avatar_service.photo_api import create_photo_app

    app = create_photo_app(tmp_path)
    alice, bob = client_for(app), client_for(app, "b")
    assert alice.get("/v1/photo-captures/capabilities").json()["min_avatar_photos"] == 8
    result = alice.post("/v1/photo-captures", files=[("photos", photo())])
    assert result.status_code == 201
    item = result.json()
    assert item["status"] == "photos_ready"
    assert item["photo_count"] == 1
    assert "model" not in item
    path = f"/v1/photo-captures/{item['id']}"
    assert bob.get(path).status_code == 404
    assert bob.get(path + "/photos/0").status_code == 404
    assert bob.delete(path).status_code == 404
    assert alice.get(path + "/photos/0").headers["content-type"] == "image/jpeg"
    # One photo cannot become an avatar; no job is created.
    assert alice.post(path + "/generate").status_code == 422
    assert alice.get(path + "/job").status_code == 404
    assert alice.get(path).json()["job"] is None
    resumed = client_for(create_photo_app(tmp_path))
    resumed.cookies.update(alice.cookies)
    assert resumed.get("/v1/photo-captures").json()[0]["id"] == item["id"]
    assert alice.delete(path).status_code == 204
    assert alice.get(path).status_code == 404


def test_bad_batch_is_atomic_and_foreign_origin_rejected(tmp_path):
    from avatar_service.photo_api import create_photo_app

    client = client_for(create_photo_app(tmp_path))
    result = client.post(
        "/v1/photo-captures",
        files=[("photos", photo()), ("photos", ("bad.jpg", b"bad", "image/jpeg"))],
    )
    assert result.status_code == 422
    assert client.get("/v1/photo-captures").json() == []
    assert (
        client.post(
            "/v1/photo-captures",
            files=[("photos", photo())],
            headers={"Origin": "https://foreign.example"},
        ).status_code
        == 403
    )
    assert (
        client.post("/v1/photo-captures", files=[("photos", photo())] * 33).status_code
        == 413
    )


def test_authentication_and_role_are_checked_before_accepting_photos(tmp_path):
    from avatar_service.photo_api import create_photo_app

    app = create_photo_app(tmp_path)
    anonymous = TestClient(app, headers=ORIGIN)
    assert anonymous.get("/health").status_code == 200
    assert anonymous.get("/v1/photo-captures").status_code == 401
    assert anonymous.post("/v1/photo-captures", files=[("photos", photo())]).status_code == 401
    splat = client_for(app, "s")
    assert splat.get("/v1/photo-captures").status_code == 200
    assert splat.post("/v1/photo-captures", files=[("photos", photo())]).status_code == 403
    assert list(tmp_path.glob("*/capture.json")) == []


def test_photo_identity_survives_token_rotation_and_cookie_writes_require_origin(tmp_path):
    from avatar_service.photo_api import create_photo_app

    app = create_photo_app(tmp_path)
    alice = client_for(app)
    item = alice.post("/v1/photo-captures", files=[("photos", photo())]).json()
    rotated = client_for(app, "s")  # Same account, different token and current role.
    assert rotated.get("/v1/photo-captures").json()[0]["id"] == item["id"]
    assert rotated.post(f"/v1/photo-captures/{item['id']}/generate").status_code == 403
    without_origin = TestClient(app)
    without_origin.cookies.update(alice.cookies)
    assert without_origin.delete(f"/v1/photo-captures/{item['id']}").status_code == 403


def test_bearer_client_can_write_without_origin_and_uses_account_ownership(tmp_path):
    from avatar_service.photo_api import create_photo_app

    app = create_photo_app(tmp_path)
    client = TestClient(app, headers={"Authorization": "Bearer " + TOKENS["a"]})
    result = client.post("/v1/photo-captures", files=[("photos", photo())])
    assert result.status_code == 201
    capture_id = result.json()["id"]
    assert client_for(app).get(f"/v1/photo-captures/{capture_id}").status_code == 200
    assert client.delete(f"/v1/photo-captures/{capture_id}").status_code == 204


def test_bearer_writes_reject_a_supplied_foreign_origin(tmp_path):
    from avatar_service.photo_api import create_photo_app

    client = TestClient(create_photo_app(tmp_path), headers={
        "Authorization": "Bearer " + TOKENS["a"], "Origin": "https://foreign.example",
    })
    assert client.post("/v1/photo-captures", files=[("photos", photo())]).status_code == 403


@pytest.mark.parametrize("authorization", ["", "Basic credentials", "Bearer ", "Bearer invalid", "Bearer " + TOKENS["b"] + " extra"])
def test_invalid_authorization_cannot_fall_back_to_a_valid_cookie(tmp_path, authorization):
    from avatar_service.photo_api import create_photo_app

    client = client_for(create_photo_app(tmp_path))
    assert client.get("/v1/photo-captures", headers={"Authorization": authorization}).status_code == 401


def test_bearer_identity_takes_precedence_over_cookie_identity(tmp_path):
    from avatar_service.photo_api import create_photo_app

    app = create_photo_app(tmp_path)
    client = client_for(app)
    result = client.post("/v1/photo-captures", files=[("photos", photo())], headers={"Authorization": "Bearer " + TOKENS["b"]})
    assert result.status_code == 201
    path = f"/v1/photo-captures/{result.json()['id']}"
    assert client_for(app, "b").get(path).status_code == 200
    assert client_for(app).get(path).status_code == 404


def test_legacy_room_session_cookie_cannot_authenticate(tmp_path):
    from avatar_service.photo_api import create_photo_app

    client = TestClient(create_photo_app(tmp_path), headers=ORIGIN)
    client.cookies.set("room_session", "a" * 43)
    assert client.get("/v1/photo-captures").status_code == 401


def test_legacy_photo_cookie_claims_only_its_own_capture_directory(tmp_path):
    import hashlib
    import json
    from avatar_service.photo_api import create_photo_app

    token = "d" * 64
    capture_id = str(uuid.uuid4())
    legacy = tmp_path / hashlib.sha256(token.encode()).hexdigest() / capture_id
    legacy.mkdir(parents=True)
    (legacy / "capture.json").write_text(json.dumps({"id": capture_id, "created_at": "2026"}))
    app = create_photo_app(tmp_path)
    alice = client_for(app)
    alice.cookies.set("avatar_photo_session", token)
    assert alice.get("/v1/photo-captures").json()[0]["id"] == capture_id
    assert client_for(app, "b").get(f"/v1/photo-captures/{capture_id}").status_code == 404
    assert (tmp_path / ALICE / capture_id / "capture.json").is_file()


def test_avatar_job_lifecycle_is_private_and_cancellable(tmp_path):
    import json
    from avatar_service.photo_api import create_photo_app

    app = create_photo_app(tmp_path)
    alice, bob = client_for(app), client_for(app, "b")
    item = alice.post("/v1/photo-captures", files=[("photos", photo())] * 8).json()
    path = f"/v1/photo-captures/{item['id']}"
    job = alice.post(path + "/generate")
    assert job.status_code == 202
    assert job.json()["state"] == "queued"
    assert [stage["id"] for stage in job.json()["stages"]] == ["cameras", "masks", "prepare", "train", "skeleton", "rig"]
    assert alice.post(path + "/generate").status_code == 409
    assert bob.get(path + "/job").status_code == 404
    assert bob.post(path + "/job/cancel").status_code == 404
    assert alice.get("/v1/photo-captures").json()[0]["job"]["state"] == "queued"
    # An active job protects its photos and has no model yet.
    assert alice.delete(path).status_code == 409
    assert alice.get(path + "/avatar/model.ply").status_code == 404
    assert alice.post(path + "/job/cancel").json()["cancelling"] is True
    folder = tmp_path / ALICE / item["id"]
    assert (folder / "cancel-request").exists()
    # The worker finishes the job; the exported model then becomes downloadable to its owner only.
    (folder / "work/export").mkdir(parents=True)
    (folder / "work/export/person.ply").write_bytes(b"ply")
    (folder / "work/renders").mkdir()
    (folder / "work/renders/0-gt-vs-render.jpg").write_bytes(b"jpg")
    (folder / "work/job.log").write_text("line 1\nline 2\n")
    (folder / "job.json").write_text(json.dumps({**job.json(), "state": "done"}))
    (folder / "cancel-request").unlink()
    assert alice.get(path + "/job").json()["logTail"] == ["line 1", "line 2"]
    assert alice.get(path + "/avatar/model.ply").content == b"ply"
    assert bob.get(path + "/avatar/model.ply").status_code == 404
    assert alice.get(path + "/avatar/previews/0-gt-vs-render.jpg").status_code == 200
    assert alice.get(path + "/avatar/previews/..%2Fjob.json").status_code == 404
    assert alice.get(path + "/avatar/rig/manifest.json").status_code == 404
    (folder / "work/rig").mkdir()
    (folder / "work/rig/manifest.json").write_text("{}")
    assert alice.get(path + "/avatar/rig/manifest.json").json() == {}
    assert bob.get(path + "/avatar/rig/manifest.json").status_code == 404
    assert alice.get(path + "/avatar/rig/job.log").status_code == 404
    # Restarting clears the previous outputs.
    assert alice.post(path + "/generate").status_code == 202
    assert not (folder / "work").exists()
    assert alice.post(path + "/job/cancel").status_code == 202


def test_video_set_is_streamed_validated_and_gets_a_frames_stage(tmp_path):
    from avatar_service.photo_api import create_photo_app

    app = create_photo_app(tmp_path)
    alice, bob = client_for(app), client_for(app, "b")
    video = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 4096
    headers = {"Content-Type": "video/mp4", "X-File-Name": "turn.mp4"}
    assert alice.post("/v1/photo-captures/video", content=b"not a video" * 200, headers=headers).status_code == 422
    assert alice.post("/v1/photo-captures/video", content=video, headers={"Content-Type": "image/png"}).status_code == 415
    too_big = alice.post("/v1/photo-captures/video", content=b"x", headers={**headers, "Content-Length": str(2 * 1024 ** 3)})
    assert too_big.status_code == 413
    item = alice.post("/v1/photo-captures/video", content=video, headers=headers)
    assert item.status_code == 201
    item = item.json()
    assert item["kind"] == "video" and item["video"]["bytes"] == len(video) and item["video"]["name"] == "turn.mp4"
    assert (tmp_path / ALICE / item["id"] / "video.mp4").read_bytes() == video
    path = f"/v1/photo-captures/{item['id']}"
    assert bob.get(path).status_code == 404
    # Frames do not exist until the worker extracts them; then they are served as the set's photos.
    assert alice.get(path + "/photos/0").status_code == 404
    job = alice.post(path + "/generate").json()
    assert [stage["id"] for stage in job["stages"]] == ["frames", "cameras", "masks", "prepare", "train", "skeleton", "rig"]
    (tmp_path / ALICE / item["id"] / "work/input").mkdir(parents=True)
    (tmp_path / ALICE / item["id"] / "work/input/0.jpg").write_bytes(b"jpg")
    assert alice.get(path + "/photos/0").content == b"jpg"
    # A WebM signature is accepted too; a photo-only role cannot upload video.
    webm = bytes.fromhex("1a45dfa3") + b"\x00" * 2048
    assert alice.post("/v1/photo-captures/video", content=webm, headers={"Content-Type": "video/webm"}).status_code == 201
    uploader = client_for(app, "s")
    assert uploader.post("/v1/photo-captures/video", content=webm, headers={"Content-Type": "video/webm"}).status_code == 403
