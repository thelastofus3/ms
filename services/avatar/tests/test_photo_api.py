import io

from fastapi.testclient import TestClient
from PIL import Image


def photo():
    data = io.BytesIO()
    Image.new("RGB", (128, 256), "red").save(data, "PNG")
    return ("person.png", data.getvalue(), "image/png")


def test_upload_envelope_is_bounded_before_multipart(tmp_path):
    from avatar_service.photo_api import create_photo_app

    client = TestClient(create_photo_app(tmp_path))
    response = client.post(
        "/v1/photo-captures",
        content=b"x",
        headers={"Content-Length": str(102 * 1024 * 1024)},
    )
    assert response.status_code == 413


def test_photo_capture_is_private_persistent_and_not_a_fake_avatar(tmp_path):
    from avatar_service.photo_api import create_photo_app

    app = create_photo_app(tmp_path)
    alice, bob = TestClient(app), TestClient(app)
    assert (
        alice.get("/v1/photo-captures/capabilities").json()["generation_available"]
        is False
    )
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
    assert alice.post(path + "/generate").status_code == 503
    resumed = TestClient(create_photo_app(tmp_path))
    resumed.cookies.update(alice.cookies)
    assert resumed.get("/v1/photo-captures").json()[0]["id"] == item["id"]
    assert alice.delete(path).status_code == 204
    assert alice.get(path).status_code == 404


def test_bad_batch_is_atomic_and_foreign_origin_rejected(tmp_path):
    from avatar_service.photo_api import create_photo_app

    client = TestClient(create_photo_app(tmp_path))
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
