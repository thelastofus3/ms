import { expect, test } from "@playwright/test";
import { reconstructedRoom } from "./room-fixture";
import { testAccount } from "./auth-fixture";

test("a legacy reconstructed package loads collision geometry and starts walking", async ({ page }) => {
  await reconstructedRoom(page);
  await page.goto("/#room-viewer?job=legacy-reconstructed");
  await expect(page.getByText("Room ready. Start walking or explore from above.", { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("link", { name: "Edit room setup", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Live human markers" })).toBeVisible();
  await page.getByRole("button", { name: "Start walking", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restart at start point", exact: true })).toBeVisible();
  await expect(page.getByText("Click the room, then use WASD and the mouse. Escape releases the mouse.", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Orbit view", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start walking", exact: true })).toBeVisible();
});

test("a PLY uploader retains camera access to their previously reconstructed room", async ({ page }) => {
  await reconstructedRoom(page, () => true, { ...testAccount, role: "SPLAT_UPLOADER" });
  await page.goto("/#room-tracking?job=legacy-reconstructed");
  await expect(page.getByRole("button", { name: "Start camera", exact: true })).toBeEnabled({ timeout: 15000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a revoked session returns to login and ends active camera capture", async ({ page }) => {
  let valid = true;
  await reconstructedRoom(page, () => valid);
  await page.addInitScript(() => {
    const surface = document.createElement("canvas"); surface.width = 640; surface.height = 480;
    const context = surface.getContext("2d")!; context.fillStyle = "#808080"; context.fillRect(0, 0, 640, 480);
    const stream = surface.captureStream(10);
    const testWindow = window as unknown as { capturedTrack: MediaStreamTrack };
    testWindow.capturedTrack = stream.getVideoTracks()[0];
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => stream });
  });
  await page.goto("/#room-tracking?job=legacy-reconstructed");
  await expect(page.getByRole("button", { name: "Start camera", exact: true })).toBeEnabled({ timeout: 15000 });
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop camera", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { capturedTrack: MediaStreamTrack }).capturedTrack.readyState)).toBe("live");
  valid = false;
  await page.getByRole("link", { name: "Room reconstruction", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { capturedTrack: MediaStreamTrack }).capturedTrack.readyState)).toBe("ended");
  await expect(page.getByRole("button", { name: "Stop camera", exact: true })).toHaveCount(0);
});
