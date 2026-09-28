import io
import os
import uuid

import pytest
from fastapi.testclient import TestClient
from PIL import Image


@pytest.fixture(params=["sqlite", "postgres"])
def api(tmp_path, request):
    from avatar_service.api import create_app
    from avatar_service.store import Store

    if request.param == "postgres" and not os.getenv("AVATAR_TEST_DATABASE_URL"):
        pytest.skip("Set AVATAR_TEST_DATABASE_URL for PostgreSQL integration")
    store = Store(
        os.environ["AVATAR_TEST_DATABASE_URL"]
        if request.param == "postgres"
        else "sqlite:///" + str(tmp_path / "jobs.db")
    )
    # Unique owners isolate tests without deleting another session's data.
    suffix = str(uuid.uuid4())
    return TestClient(
        create_app(
            store=store,
            data_dir=tmp_path / "data",
            tokens={"alice-token": "alice-" + suffix, "bob-token": "bob-" + suffix},
        )
    ), store


def auth(who="alice"):
    return {"Authorization": f"Bearer {who}-token"}


def test_empty_idempotency_key_is_rejected(api):
    client, _ = api
    for _ in range(2):
        assert (
            client.post(
                "/v1/avatar-jobs",
                headers={**auth(), "Idempotency-Key": ""},
                json={"profile": {"name": "Invalid"}},
            ).status_code
            == 422
        )


def test_jobs_are_owned_idempotent_and_cancellable(api):
    client, store = api
    assert (
        client.post("/v1/avatar-jobs", json={"profile": {"name": "A"}}).status_code
        == 401
    )
    headers = {**auth(), "Idempotency-Key": "create-a"}
    first = client.post(
        "/v1/avatar-jobs", headers=headers, json={"profile": {"name": "A"}}
    )
    assert first.status_code == 202
    job = first.json()
    second = client.post(
        "/v1/avatar-jobs", headers=headers, json={"profile": {"name": "A"}}
    )
    assert second.json()["id"] == job["id"]
    assert (
        client.post(
            "/v1/avatar-jobs", headers=headers, json={"profile": {"name": "B"}}
        ).status_code
        == 409
    )
    assert (
        client.get("/v1/avatar-jobs/" + job["id"], headers=auth("bob")).status_code
        == 404
    )
    assert (
        client.post("/v1/avatar-jobs/" + job["id"] + "/cancel", headers=auth()).json()[
            "status"
        ]
        == "CANCELLED"
    )
    assert store.claim("worker-1") is None


def test_reference_owner_and_image_validation(api):
    client, _ = api
    image = Image.new("RGB", (32, 32), "red")
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    response = client.post(
        "/v1/references",
        headers=auth(),
        files={"file": ("person.png", buf.getvalue(), "image/png")},
    )
    assert response.status_code == 201
    reference = response.json()["id"]
    assert (
        client.get("/v1/references/" + reference, headers=auth("bob")).status_code
        == 404
    )
    assert (
        client.post(
            "/v1/avatar-jobs",
            headers=auth("bob"),
            json={"profile": {"name": "B", "references": [reference]}},
        ).status_code
        == 404
    )
    assert (
        client.post(
            "/v1/references",
            headers=auth(),
            files={"file": ("bad.png", b"not an image", "image/png")},
        ).status_code
        == 422
    )


def test_worker_failure_is_persistent_and_not_published(api):
    from avatar_service.worker import Worker

    client, store = api
    job = client.post(
        "/v1/avatar-jobs", headers=auth(), json={"profile": {"name": "A"}}
    ).json()

    def broken(*args, **kwargs):
        raise RuntimeError("Missing asset")

    worker = Worker(store, client.app.state.data_dir, generator=broken)
    assert worker.run_once()
    result = client.get("/v1/avatar-jobs/" + job["id"], headers=auth()).json()
    assert result["status"] == "FAILED"
    assert "Missing asset" in result["error"]
    assert (
        client.get(
            f"/v1/avatars/{job['avatar_id']}/versions/1/package", headers=auth()
        ).status_code
        == 404
    )


def test_expired_worker_cannot_publish_after_reclaim(api):
    client, store = api
    job = client.post(
        "/v1/avatar-jobs", headers=auth(), json={"profile": {"name": "A"}}
    ).json()
    claimed = store.claim("first", now=100, lease_seconds=5)
    assert claimed["id"] == job["id"]
    assert store.claim("second", now=104) is None
    recovered = store.claim("second", now=106)
    assert recovered["id"] == job["id"]
    assert not store.finish(job["id"], "first", "FAILED", error="late failure")
    assert store.finish(job["id"], "second", "FAILED", error="recovered")


def test_success_approval_download_and_cancellation_race(api):
    from test_contracts import fixture_glb

    from avatar_service.models import BONE_NAMES
    from avatar_service.packages import write_package
    from avatar_service.worker import Worker

    client, store = api

    def test_provider(profile, output, **kwargs):
        output.mkdir(parents=True)
        fixture_glb(output / "avatar.glb")
        write_package(
            output,
            profile,
            {
                name: {"node": i, "rest": [0, 0, 0, 1], "basis": [0, 0, 0, 1]}
                for i, name in enumerate(BONE_NAMES)
            },
            generator="test-fixture",
            avatar_id=kwargs["avatar_id"],
            version=kwargs["version"],
        )

    job = client.post(
        "/v1/avatar-jobs", headers=auth(), json={"profile": {"name": "A"}}
    ).json()
    worker = Worker(store, client.app.state.data_dir, generator=test_provider)
    assert worker.run_once()
    base = f"/v1/avatars/{job['avatar_id']}/versions/1"
    assert client.get(base, headers=auth()).json()["generator"] == "test-fixture"
    assert client.get(base, headers=auth()).json()["avatar_id"] == job["avatar_id"]
    assert client.get(base, headers=auth()).json()["version"] == 1
    assert client.get(base + "/package", headers=auth()).content[:2] == b"PK"
    assert client.get(base + "/package", headers=auth("bob")).status_code == 404
    assert client.post(base + "/approve", headers=auth()).json()["approved"] is True
    second = client.post(
        "/v1/avatar-jobs", headers=auth(), json={"profile": {"name": "B"}}
    ).json()

    def cancelled_provider(profile, output, **kwargs):
        test_provider(profile, output, **kwargs)
        client.post("/v1/avatar-jobs/" + second["id"] + "/cancel", headers=auth())

    Worker(store, client.app.state.data_dir, generator=cancelled_provider).run_once()
    assert (
        client.get("/v1/avatar-jobs/" + second["id"], headers=auth()).json()["status"]
        == "CANCELLED"
    )
    assert (
        client.get(
            f"/v1/avatars/{second['avatar_id']}/versions/1/package", headers=auth()
        ).status_code
        == 404
    )


def test_new_version_keeps_identity_and_checks_owner(api):
    client, _ = api
    job = client.post(
        "/v1/avatar-jobs", headers=auth(), json={"profile": {"name": "A"}}
    ).json()
    request = {"avatar_id": job["avatar_id"], "profile": {"name": "Adjusted"}}
    assert (
        client.post("/v1/avatar-jobs", headers=auth("bob"), json=request).status_code
        == 404
    )
    updated = client.post("/v1/avatar-jobs", headers=auth(), json=request)
    assert updated.status_code == 202
    assert updated.json()["avatar_id"] == job["avatar_id"]
    assert updated.json()["version"] == 2
    for row in (job, updated.json()):
        client.post("/v1/avatar-jobs/" + row["id"] + "/cancel", headers=auth())
