"""Run against an isolated API/PostgreSQL/S3 stack; creates disposable accounts/data.

Required: ROOM_TEST_API_URL, ROOM_TEST_ADMIN_PASSWORD, ROOM_TEST_DB_DSN.
Optional: ROOM_TEST_PHOTO_URL, ROOM_TEST_PLY_FILE, ROOM_TEST_EVIDENCE.
No credentials are printed. This script writes only to the explicitly configured test stack.
"""
import base64
import hashlib
import http.cookiejar
import io
import json
import os
from pathlib import Path
import secrets
import struct
import time
import urllib.error
import urllib.request
import uuid

import jsonschema
import psycopg

API = os.environ["ROOM_TEST_API_URL"].rstrip("/")
ORIGIN = os.getenv("ROOM_TEST_ORIGIN", "http://127.0.0.1:5173")
ADMIN_PASSWORD = os.environ["ROOM_TEST_ADMIN_PASSWORD"]
DB_DSN = os.environ["ROOM_TEST_DB_DSN"]
PHOTO_URL = os.getenv("ROOM_TEST_PHOTO_URL")
CHECKS = []


class Client:
    def __init__(self):
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))

    def call(self, path, method="GET", body=None, expected=200, headers=None):
        url = path if path.startswith("http") else API + path
        request_headers = {key: value for key, value in {"Origin": ORIGIN, **(headers or {})}.items() if value is not None}
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body).encode()
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=body, method=method, headers=request_headers)
        try:
            with self.opener.open(request, timeout=30) as response:
                status, raw, response_headers = response.status, response.read(), response.headers
        except urllib.error.HTTPError as error:
            status, raw, response_headers = error.code, error.read(), error.headers
        assert status == expected, f"{method} {url.split('?')[0]}: expected {expected}, received {status}: {raw[:300]!r}"
        return json.loads(raw) if raw and "json" in response_headers.get("Content-Type", "") else raw

    def login(self, username, password):
        result = self.call("/auth/login", "POST", {"username": username, "password": password})
        assert result["tokenType"] == "Bearer" and result["expiresIn"] == 86400
        self.access_token = result["accessToken"]
        parts = self.access_token.split(".")
        assert len(parts) == 3
        decode = lambda part: json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        header, claims = decode(parts[0]), decode(parts[1])
        assert header["alg"] == "HS256" and header["typ"] == "at+jwt"
        assert claims["iss"] == "room-api" and claims["aud"] == "room-app"
        assert claims["sub"] == result["account"]["id"] and claims["exp"] - claims["iat"] == 86400
        assert any(cookie.name == "room_access_token" and cookie.value == self.access_token for cookie in self.cookies)
        return result["account"]


def checked(label):
    CHECKS.append(label)
    print("PASS", label, flush=True)


def ply(vertices=2, nonfinite=False, rotation=None, log_scale=None, x=None):
    names = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
             "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    header = ("ply\nformat binary_little_endian 1.0\nelement vertex " + str(vertices) + "\n"
              + "".join("property float " + name + "\n" for name in names) + "end_header\n").encode()
    values = [0., 0., 0., .5, .5, .5, 2., -2., -2., -2., 1., 0., 0., 0.]
    if nonfinite:
        values[0] = float("nan")
    if rotation is not None:
        values[10] = rotation
    if log_scale is not None:
        values[7:10] = [log_scale] * 3
    if x is not None:
        values[0] = x
    return header + struct.pack("<14f", *values) * vertices


def upload(client, data, name="scene.ply", kind="splat"):
    item = client.call("/uploads", "POST", {"kind": kind, "files": [{
        "name": name, "size": len(data), "contentType": "application/octet-stream" if kind == "splat" else "video/mp4"}]})
    operation = item["files"][0]
    assert item["kind"] == kind
    parts = []
    if "url" in operation:
        client.call(operation["url"], "PUT", data)
    else:
        for part in operation["parts"]:
            offset = (part["number"] - 1) * operation["partSize"]
            request = urllib.request.Request(part["url"], data=data[offset:offset + operation["partSize"]], method="PUT")
            with urllib.request.urlopen(request, timeout=30) as response:
                parts.append({"number": part["number"], "etag": response.headers["ETag"]})
    client.call(f"/uploads/{item['id']}/complete", "POST", {"files": [{"key": operation["key"], "parts": parts}]})
    return item


def queue(client, item, key):
    body = {"uploadId": item["id"], "name": "Integration scene", "profile": "local", "idempotencyKey": key}
    return client.call("/jobs", "POST", body, expected=202), body


def terminal(client, job_id):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        job = client.call(f"/jobs/{job_id}")
        if job["state"] not in {"QUEUED", "RUNNING"}:
            return job
        time.sleep(.25)
    raise AssertionError("Import did not finish within 60 seconds")


def main():
    admin, splat, other, reconstructor = Client(), Client(), Client(), Client()
    Client().call("/jobs", expected=401)
    Client().call("/auth/login", "POST", {"username": "admin", "password": "invalid"}, expected=401)
    Client().call("/auth/login", "POST", {"username": "admin", "password": "invalid"}, expected=403, headers={"Origin": "https://foreign.example"})
    Client().call("/auth/login", "POST", {"username": "admin", "password": "invalid"}, expected=403, headers={"Origin": ""})
    admin_account = admin.login("admin", ADMIN_PASSWORD)
    assert set(admin_account) == {"id", "username", "role", "disabled"}
    checked("authentication and Origin enforcement")

    Client().call("/auth/me", headers={"Authorization": "Bearer " + admin.access_token, "Origin": None})
    admin.call("/auth/me", expected=401, headers={"Authorization": "Bearer malformed"})
    parts = admin.access_token.split(".")
    parts[2] = ("A" if parts[2][0] != "A" else "B") + parts[2][1:]
    Client().call("/auth/me", expected=401, headers={"Authorization": "Bearer " + ".".join(parts)})
    checked("signed JWT claims, Bearer transport, tampering rejection and credential precedence")

    suffix = secrets.token_hex(4)
    password = secrets.token_urlsafe(24)
    created = {}
    for role, client in [("SPLAT_UPLOADER", splat), ("SPLAT_UPLOADER", other), ("RECONSTRUCTOR", reconstructor)]:
        name = role.lower() + "-" + secrets.token_hex(4)
        account = admin.call("/auth/users", "POST", {"username": name, "password": password, "role": role})
        client.login(name, password)
        created[client] = account
    splat.call("/auth/users", expected=403)
    admin.call(f"/auth/users/{admin_account['id']}", "PATCH", {"role": "SPLAT_UPLOADER"}, expected=409)
    splat.call("/uploads", "POST", {"kind": "capture", "files": [{"name": "x.mp4", "size": 100, "contentType": "video/mp4"}]}, expected=403)
    checked("administrator-only management, last-admin protection and capture RBAC")

    data = ply()
    item = upload(splat, data)
    job, job_request = queue(splat, item, suffix)
    job = terminal(splat, job["id"])
    assert job["state"] == "IMPORTED" and job["kind"] == "splat"
    assert splat.call("/jobs", "POST", job_request, expected=202)["id"] == job["id"]
    splat.call("/jobs", "POST", {**job_request, "name": "Changed"}, expected=409)
    manifest = splat.call("/scenes/" + job["id"] + "/versions/1")
    schema = json.loads((Path(__file__).resolve().parents[3] / "contracts/space/manifest.schema.json").read_text())
    jsonschema.Draft202012Validator(schema).validate(manifest)
    assert manifest["ready"] is False and manifest["sourceType"] == "gaussian-ply"
    assert "collision" not in manifest["assets"]
    asset = manifest["assets"]["splats"]
    assert asset["sha256"] == hashlib.sha256(data).hexdigest()
    assert splat.call(asset["url"]) == data
    checked("real CPU import, scene schema, signed asset and idempotency")

    for path in [f"/jobs/{job['id']}", f"/uploads/{item['id']}", f"/scenes/{job['id']}/versions/1"]:
        other.call(path, expected=404)
    admin.call(f"/jobs/{job['id']}", expected=404)
    splat.call(item["files"][0]["url"], "PUT", b"x" * len(data))
    assert splat.call(asset["url"]) == data
    admin_job = upload(admin, ply())
    imported, _ = queue(admin, admin_job, "admin-" + suffix)
    imported = terminal(admin, imported["id"])
    admin.call(f"/jobs/{imported['id']}/reconstruct", "POST", {"idempotencyKey": "retry"}, expected=409)
    checked("owner isolation, immutable snapshot and imported reconstruction rejection")

    multipart_data = ply(300_000)
    large = upload(splat, multipart_data)
    assert len(large["files"][0]["parts"]) == 2
    large_job, _ = queue(splat, large, "multipart-" + suffix)
    assert terminal(splat, large_job["id"])["state"] == "IMPORTED"
    checked("real multipart PLY upload and import")

    invalid = upload(splat, ply(nonfinite=True))
    invalid_job, _ = queue(splat, invalid, "invalid-" + suffix)
    failed = terminal(splat, invalid_job["id"])
    assert failed["state"] == "FAILED" and "nonfinite" in failed["error"] and "manifestUrl" not in failed
    checked("malformed PLY rejected without publication")

    for index, unsafe in enumerate([ply(rotation=1e-45), ply(rotation=3.4028234663852886e38), ply(log_scale=28), ply(x=1e20)]):
        unsafe_upload = upload(splat, unsafe)
        unsafe_job, _ = queue(splat, unsafe_upload, f"unsafe-{index}-" + suffix)
        unsafe_job = terminal(splat, unsafe_job["id"])
        assert unsafe_job["state"] == "FAILED" and "manifestUrl" not in unsafe_job
    checked("finite numerical overflow cases rejected before publication")

    if os.getenv("ROOM_TEST_PLY_FILE"):
        file = Path(os.environ["ROOM_TEST_PLY_FILE"])
        source_bytes = file.read_bytes()
        source = upload(splat, source_bytes, file.name)
        source_job, _ = queue(splat, source, "real-export-" + suffix)
        source_job = terminal(splat, source_job["id"])
        assert source_job["state"] == "IMPORTED", source_job.get("error")
        source_manifest = splat.call(f"/scenes/{source_job['id']}/versions/1")
        assert source_manifest["assets"]["splats"]["sha256"] == hashlib.sha256(source_bytes).hexdigest()
        assert source_manifest["assets"]["splats"]["bytes"] == file.stat().st_size
        checked("real Gaussian PLY export imports with unchanged checksum")

    old_capture = upload(reconstructor, b"x" * 100, "video.mp4", "capture")
    account = created[reconstructor]
    admin.call(f"/auth/users/{account['id']}", "PATCH", {"role": "SPLAT_UPLOADER"})
    reconstructor.call("/auth/me", expected=401)
    reconstructor.login(account["username"], password)
    reconstructor.call(f"/uploads/{old_capture['id']}", expected=403)
    reconstructor.call(f"/uploads/{old_capture['id']}/complete", "POST", {"files": []}, expected=403)
    reconstructor.call("/jobs", "POST", {"uploadId": old_capture["id"], "name": "Denied", "profile": "local", "idempotencyKey": "denied-" + suffix}, expected=403)
    checked("role downgrade revokes account JWTs and blocks sealed/resumed captures")

    legacy_owner, recovery_token = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    legacy_upload, legacy_job = uuid.uuid4(), uuid.uuid4()
    with psycopg.connect(DB_DSN) as connection:
        connection.execute("INSERT INTO room_uploads(id,owner,media,sealed) VALUES(%s,%s,'[]',true)", (legacy_upload, legacy_owner))
        connection.execute("INSERT INTO room_jobs(id,owner,upload_id,name,profile,idempotency_key,state) VALUES(%s,%s,%s,'Legacy','local',%s,'FAILED')", (legacy_job, legacy_owner, legacy_upload, suffix))
        connection.execute("INSERT INTO room_session_recovery(token_hash,owner,job_id,expires_at) VALUES(%s,%s,%s,now()+interval '1 hour')", (hashlib.sha256(recovery_token.encode()).hexdigest(), legacy_owner, legacy_job))
    assert splat.call("/session/recover", "POST", {"token": recovery_token})["jobId"] == str(legacy_job)
    assert splat.call(f"/jobs/{legacy_job}")["name"] == "Legacy"
    other.call(f"/jobs/{legacy_job}", expected=404)
    splat.call("/session/recover", "POST", {"token": recovery_token}, expected=410)
    checked("legacy account claim with idempotency collision and one-use token")

    if PHOTO_URL:
        from PIL import Image
        pixels = io.BytesIO()
        Image.new("RGB", (20, 20), "red").save(pixels, "PNG")
        boundary = "integration-" + suffix
        form = (f'--{boundary}\r\nContent-Disposition: form-data; name="photos"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n'.encode()
                + pixels.getvalue() + f"\r\n--{boundary}--\r\n".encode())
        headers = {"Content-Type": "multipart/form-data; boundary=" + boundary}
        Client().call(PHOTO_URL + "/v1/photo-captures", expected=401)
        splat.call(PHOTO_URL + "/v1/photo-captures", "POST", form, expected=403, headers=headers)
        saved = admin.call(PHOTO_URL + "/v1/photo-captures", "POST", form, expected=201, headers=headers)
        splat.call(PHOTO_URL + "/v1/photo-captures/" + saved["id"], expected=404)
        admin.call(PHOTO_URL + "/v1/photo-captures/" + saved["id"], "DELETE", expected=204)
        checked("real photo API central authentication, role and ownership")

    disabled = created[other]
    admin.call(f"/auth/users/{disabled['id']}", "PATCH", {"disabled": True})
    other.call("/auth/me", expected=401)
    other.call("/auth/login", "POST", {"username": disabled["username"], "password": password}, expected=401)
    splat.call("/auth/logout", "POST")
    splat.call("/jobs", expected=401)
    checked("disable and logout invalidate access")
    result = {"checks": CHECKS, "passed": len(CHECKS), "api": API, "gpuWorker": False}
    if os.getenv("ROOM_TEST_EVIDENCE"):
        Path(os.environ["ROOM_TEST_EVIDENCE"]).write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({"passed": len(CHECKS), "gpuWorker": False}), flush=True)


if __name__ == "__main__":
    main()
