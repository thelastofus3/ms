import { test, expect, type Page } from "@playwright/test";
import { testAccount, testQuota } from "./auth-fixture";

const input = { name: "room.mp4", mimeType: "video/mp4", buffer: Buffer.from("capture") };
const queued = { id: "browser-job", name: "My room", state: "QUEUED", stage: "preprocessing", profile: "local", progress: 0, error: null, diagnostics: {}, cancel_requested: false };

async function roomService(page: Page, resumeStatus = 200) {
  const requests: string[] = [];
  let jobs: typeof queued[] = [];
  await page.route("**/v1/rooms/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    requests.push(`${request.method()} ${path}`);
    let body: unknown, status = 200;
    if (path === "/v1/rooms/auth/me") body = testAccount;
    else if (path === "/v1/rooms/quota") body = testQuota;
    else if (path === "/v1/rooms/jobs" && request.method() === "GET") body = jobs;
    else if (path === "/v1/rooms/uploads/saved-upload") {
      status = resumeStatus;
      body = status === 200 ? { id: "saved-upload", files: [{ key: "input-key", url: "/test-storage/input" }] } : { message: "Storage reconnecting. Retry shortly." };
    } else if (path === "/v1/rooms/uploads") body = { id: "new-upload", files: [{ key: "input-key", url: "/test-storage/input" }] };
    else if (path.endsWith("/complete")) body = { sealed: true };
    else if (path === "/v1/rooms/jobs" && request.method() === "POST") { body = queued; jobs = [queued]; }
    else { status = 404; body = { message: "Unexpected test request" }; }
    await route.fulfill({ status, json: body });
  });
  await page.route("**/test-storage/input", route => route.fulfill({ status: 200, headers: { ETag: "test-etag" }, body: "" }));
  return requests;
}

test("invalid room capture is explained before any upload starts", async ({ page }) => {
  const requests = await roomService(page);
  await page.goto("/#rooms");
  const submit = page.getByRole("button", { name: "Upload and reconstruct" });
  await page.getByLabel("Photos or video").setInputFiles({ name: "room.png", mimeType: "image/png", buffer: Buffer.from("photo") });
  await expect(page.getByRole("alert")).toContainText("at least 12 overlapping photos");
  await expect(submit).toBeDisabled();
  expect(requests.some(request => request === "POST /v1/rooms/uploads")).toBe(false);
  await page.getByLabel("Photos or video").setInputFiles(input);
  await expect(submit).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("temporary outage preserves a paused upload in the browser", async ({ page }) => {
  const requests = await roomService(page, 503);
  await page.goto("/#rooms");
  await page.getByLabel("Photos or video").setInputFiles(input);
  const draft = await page.getByLabel("Photos or video").evaluate(element => {
    const file = (element as HTMLInputElement).files![0];
    const saved = JSON.stringify({ fingerprint: JSON.stringify([[file.name, file.size, file.lastModified]]), uploadId: "saved-upload", completed: [{ key: "input-key", parts: [{ number: 0, etag: "complete" }] }], jobKey: "saved-job-key" });
    localStorage.setItem("room-upload-draft-v2:test-account:capture", saved);
    return saved;
  });
  await page.getByRole("button", { name: "Upload and reconstruct" }).click();
  await expect(page.getByRole("alert")).toContainText("Storage reconnecting");
  expect(await page.evaluate(() => localStorage.getItem("room-upload-draft-v2:test-account:capture"))).toBe(draft);
  expect(requests).toContain("GET /v1/rooms/uploads/saved-upload");
  expect(requests.some(request => request.startsWith("POST "))).toBe(false);
});

test("successfully queued room opens even when clearing local storage fails", async ({ page }) => {
  await roomService(page);
  await page.addInitScript(() => {
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (key === "room-upload-draft-v2:test-account:capture") throw new DOMException("Storage unavailable", "SecurityError");
      return remove.call(this, key);
    };
  });
  await page.goto("/#rooms");
  await page.getByLabel("Photos or video").setInputFiles(input);
  await page.getByRole("button", { name: "Upload and reconstruct" }).click();
  await expect(page.getByRole("heading", { name: "My room", exact: true })).toBeVisible();
  await expect(page.getByText("Capture saved. Waiting for a GPU worker to claim this job.")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
