import { test, expect } from "@playwright/test";
import { authenticated } from "./auth-fixture";
test.beforeEach(async ({ page }) => authenticated(page));

/** A tiny standard 3DGS PLY (positions, SH DC colour, opacity, scale, rotation), like the avatar worker exports. */
function gaussianPly(count: number) {
  const properties = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${count}\n${properties.map(name => `property float ${name}`).join("\n")}\nend_header\n`;
  const body = Buffer.alloc(count * properties.length * 4);
  for (let i = 0; i < count; i++) {
    const values = [Math.cos(i) * 0.2, i / count * 1.7, Math.sin(i) * 0.2, 0.5, 0.2, -0.3, 3, -4, -4, -4, 1, 0, 0, 0];
    values.forEach((value, j) => body.writeFloatLE(value, (i * properties.length + j) * 4));
  }
  return Buffer.concat([Buffer.from(header), body]);
}

test("the avatar viewer lists the account's avatars and opens a finished one", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  const done = { state: "done", stage: "done", createdAt: "2026-10-26T10:00:00Z", error: null, stages: [],
    result: { model: "model.ply", bytes: 1, gaussians: 500, heldOut: {}, previews: [] } };
  await page.route("**/v1/photo-captures", route => route.fulfill({ json: [
    { id: "22222222-2222-4222-8222-222222222222", created_at: "2026-10-26T09:00:00Z", photo_count: 24, status: "photos_ready", job: done },
  ] }));
  await page.route("**/v1/photo-captures/*/photos/*", route => route.fulfill({ status: 404 }));
  await page.route("**/avatar/model.ply", route => route.fulfill({ contentType: "application/octet-stream", body: gaussianPly(500) }));
  await page.goto("/#avatar");
  await expect(page.getByRole("heading", { name: "Avatar viewer" })).toBeVisible();
  // With no explicit choice, the newest finished avatar opens by itself.
  await expect(page.getByRole("button", { name: /24 photos/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("gaussian-status")).toHaveText("500 Gaussians · static, not yet rigged", { timeout: 30_000 });
  // Motion controls belong to rigged avatars only.
  await expect(page.getByLabel("Motion")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the avatar viewer explains how to get a first avatar", async ({ page }) => {
  await page.route("**/v1/photo-captures", route => route.fulfill({ json: [] }));
  await page.goto("/#avatar");
  await expect(page.getByText("No avatars yet. Upload photos or a walk-around video of a person and build an avatar.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Photo library →" })).toHaveAttribute("href", "#photos");
  await expect(page.getByText(/HUGS/)).toHaveCount(0);
});
