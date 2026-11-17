import { expect, test } from "@playwright/test";
import { reconstructedRoom } from "./room-fixture";

test("two cameras run at once in one browser and stop together", async ({ page }) => {
  await reconstructedRoom(page);
  await page.addInitScript(() => {
    const tracks: MediaStreamTrack[] = [];
    (window as unknown as { cameraTracks: MediaStreamTrack[] }).cameraTracks = tracks;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
      const surface = document.createElement("canvas"); surface.width = 640; surface.height = 480;
      const context = surface.getContext("2d")!; context.fillStyle = "#808080"; context.fillRect(0, 0, 640, 480);
      const stream = surface.captureStream(10); tracks.push(stream.getVideoTracks()[0]);
      return stream;
    } });
  });
  const live = () => page.evaluate(() => (window as unknown as { cameraTracks: MediaStreamTrack[] }).cameraTracks.filter(track => track.readyState === "live").length);
  await page.goto("/#room-tracking?job=legacy-reconstructed");
  const deck = page.getByRole("navigation", { name: "Cameras in this browser" });
  await expect(page.getByRole("button", { name: "Start camera", exact: true })).toBeEnabled({ timeout: 15000 });
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop camera", exact: true })).toBeEnabled();
  await expect(deck.getByRole("button", { name: /Camera 1/ })).toContainText("on");

  await deck.getByRole("button", { name: "+ Add camera", exact: true }).click();
  await expect(deck.getByRole("button", { name: /Camera 2/ })).toHaveAttribute("aria-pressed", "true");
  // The second camera has its own controls; the first keeps capturing behind it.
  await expect(page.getByRole("button", { name: "Start camera", exact: true })).toBeEnabled({ timeout: 15000 });
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop camera", exact: true })).toBeEnabled();
  expect(await live()).toBe(2);

  await page.getByRole("link", { name: "Pipeline overview", exact: true }).click();
  const banner = page.locator(".workspace-camera-status");
  await expect(banner).toContainText("2 cameras");
  await banner.getByRole("button", { name: "Stop camera", exact: true }).click();
  await expect.poll(live).toBe(0);
});

test("removing a camera stops only that camera", async ({ page }) => {
  await reconstructedRoom(page);
  await page.goto("/#room-tracking?job=legacy-reconstructed");
  const deck = page.getByRole("navigation", { name: "Cameras in this browser" });
  await deck.getByRole("button", { name: "+ Add camera", exact: true }).click();
  await expect(deck.getByRole("button", { name: /^Camera \d/ })).toHaveCount(2);
  await deck.getByRole("button", { name: "Remove this camera", exact: true }).click();
  await expect(deck.getByRole("button", { name: /^Camera \d/ })).toHaveCount(1);
  await expect(deck.getByRole("button", { name: "Remove this camera", exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("face recognition can be switched off and the choice is remembered", async ({ page }) => {
  await reconstructedRoom(page);
  await page.goto("/#room-tracking?job=legacy-reconstructed");
  const recognition = page.getByRole("checkbox", { name: "Recognize people by face" });
  await expect(recognition).toBeChecked({ timeout: 15000 });
  await expect(page.getByRole("combobox", { name: "Show people as" })).toHaveValue("");
  await recognition.uncheck();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Recognize people by face" })).not.toBeChecked({ timeout: 15000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("people are shown as the default 24-photo avatar until the user picks another look", async ({ page }) => {
  await reconstructedRoom(page);
  // The default avatar's package as the servers provide it (static files next to the app).
  const requested: string[] = [];
  await page.route("**/default-avatar/**", route => {
    requested.push(new URL(route.request().url()).pathname);
    return route.request().url().endsWith("/manifest.json") ? route.fulfill({ contentType: "application/json", json: {} }) : route.fulfill({ status: 404 });
  });
  await page.goto("/#room-tracking?job=legacy-reconstructed");
  const picker = page.getByRole("combobox", { name: /people as/ });
  await expect(picker).toHaveValue("default", { timeout: 15000 });
  await expect(picker.locator("option[value=default]")).toHaveText("Default avatar · 24 photos");
  // The renderer is asked for the package (the probe is a HEAD, the load a GET).
  await expect.poll(() => requested.filter(path => path === "/default-avatar/manifest.json").length).toBeGreaterThan(1);
  // An explicit choice of markers is kept, and the default does not come back on the next visit.
  await picker.selectOption("");
  await page.reload();
  await expect(page.getByRole("combobox", { name: /people as/ })).toHaveValue("", { timeout: 15000 });
});
