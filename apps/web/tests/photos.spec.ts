import { test, expect } from "@playwright/test";
import { authenticated, testAccessToken } from "./auth-fixture";
test.beforeEach(async ({ page, context }) => {
  await authenticated(page);
  await page.route("**/v1/rooms/auth/me", route => route.fulfill({ json: { id: "00000000-0000-4000-8000-000000000001", username: "photo-tester", role: "RECONSTRUCTOR", disabled: false } }));
  await context.addCookies([{ name: "room_access_token", value: testAccessToken, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Strict" }]);
});

test("photographic app has no legacy entry and stores personal photos honestly", async ({
  page,
}) => {
  await page.route("**/v1/photo-captures", async (route) => {
    if (route.request().method() === "GET")
      await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.goto("/?mode=mesh#photos");
  await expect(
    page.getByRole("heading", { name: "Photo library" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Skeleton prototype" }),
  ).toHaveCount(0);
  await page.getByLabel("Photos or a video").setInputFiles({
    name: "test.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9Y0AAAAASUVORK5CYII=",
      "base64",
    ),
  });
  // One photo can be saved but cannot start an avatar build.
  await expect(page.getByText("1 photo selected — an avatar needs at least 8; you can still save them.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload and build avatar" })).toBeDisabled();
  await page.getByRole("button", { name: "Upload only" }).click();
  await expect(page.getByText("1 photos", { exact: true })).toBeVisible();
  // One photo cannot become an avatar; the page says why instead of failing later.
  await expect(page.getByRole("button", { name: "Build 3D avatar" })).toBeDisabled();
  await expect(page.getByText("Add at least 8 photos to build an avatar.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("link", { name: "Photo library", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Photo library" })).toBeVisible();
  await expect(page.getByText("1 photos", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete set" }).click();
  await expect(page.getByText("No saved photo sets yet.")).toBeVisible();
  await page.screenshot({
    path: "../../.runtime/personal-photos-browser.png",
    fullPage: true,
  });
});

test("avatar build progress is visible in the library and the viewer", async ({ page }) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const job = {
    state: "running", stage: "train", createdAt: "2026-10-26T10:00:00Z", startedAt: new Date(Date.now() - 600000).toISOString(), error: null,
    stages: [
      { id: "cameras", label: "Camera positions", state: "done", progress: 1, message: "24/24 cameras, 0.90 px error", startedAt: "2026-10-26T10:00:00Z", finishedAt: "2026-10-26T10:01:00Z" },
      { id: "masks", label: "Person masks", state: "done", progress: 1, message: "Mask agreement: mean IoU 0.95, worst 0.91" },
      { id: "prepare", label: "Training data", state: "done", progress: 1 },
      { id: "train", label: "Gaussian training", state: "running", progress: 0.45, message: "Training step 7,500 of 15,000", metrics: { etaSeconds: 420 }, startedAt: new Date().toISOString() },
    ],
  };
  await page.route("**/v1/photo-captures", route => route.fulfill({ json: [{ id, created_at: "2026-10-26T09:00:00Z", photo_count: 24, status: "photos_ready", job }] }));
  await page.route(`**/v1/photo-captures/${id}/photos/*`, route => route.fulfill({ status: 404 }));
  await page.goto("/#photos");
  await expect(page.getByText("Building avatar")).toBeVisible();
  await expect(page.getByText("Training step 7,500 of 15,000 · about 7 min 0 s left")).toBeVisible();
  await expect(page.getByText("24/24 cameras, 0.90 px error")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel build" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Delete set" })).toBeDisabled();
  await page.goto("/#avatar?capture=" + id);
  await expect(page.getByRole("button", { name: /24 photos/ })).toContainText(/Building · \d+%/);
  await expect(page.getByText(/This avatar is still being built/)).toBeVisible();
});

test("a walk-around video can be saved as an avatar source", async ({ page }) => {
  await page.goto("/#photos");
  const video = Buffer.concat([Buffer.from("000000186674797069736f6d", "hex"), Buffer.alloc(8192)]);
  const photo = { name: "a.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9Y0AAAAASUVORK5CYII=", "base64") };
  const dropzone = page.getByLabel("Photos or a video");
  await dropzone.setInputFiles([photo, { name: "turn.mp4", mimeType: "video/mp4", buffer: video }]);
  await expect(page.getByRole("alert")).toHaveText("Choose either photos or one video, not both.");
  await dropzone.setInputFiles({ name: "turn.mp4", mimeType: "video/mp4", buffer: video });
  await expect(page.getByText("▶ turn.mp4 · 0 MB")).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload and build avatar" })).toBeEnabled();
  await page.getByRole("button", { name: "Upload only" }).click();
  await expect(page.getByText("Video · 0 MB", { exact: true })).toBeVisible();
  await expect(page.getByText("▶ Video · frames appear after extraction")).toBeVisible();
  // Videos have no photo minimum; frames are chosen by the worker.
  await expect(page.getByRole("button", { name: "Build 3D avatar" })).toBeEnabled();
  await page.getByRole("button", { name: "Delete set" }).click();
  await expect(page.getByText("No saved photo sets yet.")).toBeVisible();
});

test("dropping a video onto the drop zone selects it", async ({ page }) => {
  await page.goto("/#photos");
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(2048)], "walk.mov", { type: "video/quicktime" }));
    return data;
  });
  const zone = page.locator(".photo-dropzone");
  await zone.dispatchEvent("dragover", { dataTransfer: transfer });
  await expect(zone).toHaveAttribute("data-dragging", "true");
  await zone.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.getByText("▶ walk.mov · 0 MB")).toBeVisible();
  await expect(zone).toHaveAttribute("data-dragging", "false");
});
