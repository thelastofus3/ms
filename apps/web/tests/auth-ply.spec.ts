import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { loginResponse, testAccessToken, testQuota, testQuotaLimits } from "./auth-fixture";

const account = { id: "ply-account", username: "importer", role: "SPLAT_UPLOADER", disabled: false };
test("failed login stays on the form and can be retried successfully", async ({ page }) => {
  await page.route("**/v1/rooms/auth/**", route => {
    if (route.request().url().endsWith("/logout")) return route.fulfill({ status: 204 });
    if (route.request().url().endsWith("/login") && route.request().postDataJSON().password === "correct-password") return route.fulfill({ json: loginResponse(account) });
    return route.fulfill({ status: 401, json: { message: "Invalid username or password" } });
  });
  await page.goto("/#pipelines");
  await page.getByLabel("Username", { exact: true }).fill("importer");
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid username or password");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill("correct-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choose a pipeline", exact: true })).toBeVisible();
  await expect(page.locator(".workspace-account")).toContainText("importer");
  await expect(page.locator(".workspace-account")).toContainText("PLY uploader");
  await expect(page.getByRole("link", { name: "Accounts", exact: true })).toHaveCount(0);
  const storedValues = await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)]);
  expect(storedValues.join(" ")).not.toContain(testAccessToken);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
});

for (const change of ["role", "disabled"] as const) test(`an administrator stays signed in after an unchanged save and signs out after their ${change} changes`, async ({ page }) => {
  const admin = { id: "admin-id", username: "admin", role: "ADMIN", disabled: false };
  await page.route("**/v1/rooms/auth/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith("/quota")) return route.fulfill({ json: testQuotaLimits });
    return route.fulfill({ json: path.endsWith("/me") ? admin : request.method() === "GET" ? [admin, { ...admin, id: "backup-admin", username: "backup" }] : { ...admin, ...request.postDataJSON() } });
  });
  await page.goto("/#admin");
  const editor = page.getByRole("form", { name: "Edit admin", exact: true });
  await editor.getByRole("button", { name: "Save account", exact: true }).click();
  await expect(editor.getByRole("button", { name: "Save account", exact: true })).toBeEnabled();
  if (change === "role") await editor.getByRole("combobox").selectOption("RECONSTRUCTOR");
  else await editor.getByLabel("Disabled account", { exact: true }).check();
  await editor.getByRole("button", { name: "Save account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
});

test("administrator assigns roles to registered accounts and changing their own password returns to login", async ({ page }) => {
  const admin = { id: "admin-id", username: "admin", role: "ADMIN", disabled: false };
  const registered = { id: "registered-id", username: "new-user", role: "SPLAT_UPLOADER", disabled: false };
  const mutations: { path: string; method: string; body: unknown }[] = [];
  await page.route("**/v1/rooms/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith("/quota")) return route.fulfill({ json: testQuotaLimits });
    if (request.method() === "GET") return route.fulfill({ json: path.endsWith("/auth/me") ? admin : [admin, registered] });
    const body = request.postDataJSON(); mutations.push({ path, method: request.method(), body });
    return route.fulfill({ json: path.endsWith("/admin-id") ? admin : { ...registered, role: body.role, disabled: body.disabled } });
  });
  await page.goto("/#admin");
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
  await expect(page.getByRole("form", { name: "Create account", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create account", exact: true })).toHaveCount(0);
  const editor = page.getByRole("form", { name: "Edit new-user", exact: true });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("combobox")).toHaveValue("SPLAT_UPLOADER");
  await editor.getByRole("combobox").selectOption("RECONSTRUCTOR");
  await editor.getByLabel("Disabled account", { exact: true }).check();
  await editor.getByLabel("New password", { exact: true }).fill("replacement-password");
  await editor.getByRole("button", { name: "Save account", exact: true }).click();
  await expect(editor.getByRole("button", { name: "Save account", exact: true })).toBeEnabled();
  expect(mutations).toEqual([
    { path: "/v1/rooms/auth/users/registered-id", method: "PATCH", body: { role: "RECONSTRUCTOR", disabled: true, password: "replacement-password" } },
  ]);
  const self = page.getByRole("form", { name: "Edit admin", exact: true });
  await self.getByLabel("New password", { exact: true }).fill("changed-admin-password");
  await self.getByRole("button", { name: "Save account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
});
test("login gates requests, retains recovery until login, and restricts PLY-only accounts", async ({ page }) => {
  let authenticated = false;
  const requests: string[] = [];
  await page.route("**/v1/rooms/**", async route => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path.endsWith("/auth/login")) { authenticated = true; return route.fulfill({ json: loginResponse(account) }); }
    if (path.endsWith("/auth/me")) return route.fulfill({ status: authenticated ? 200 : 401, json: authenticated ? account : { message: "Login required" } });
    if (path.endsWith("/session/recover")) return route.fulfill({ json: { jobId: "legacy-job" } });
    if (path === "/v1/rooms/quota") return route.fulfill({ json: testQuota });
    return route.fulfill({ json: [] });
  });
  await page.goto("/#rooms?recover=one-use-secret");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(requests).toEqual(["/v1/rooms/auth/me"]);
  expect(page.url()).toContain("recover=one-use-secret");
  await page.getByLabel("Username", { exact: true }).fill("importer");
  await page.getByLabel("Password", { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Gaussian PLY file")).toBeVisible();
  expect(requests).toContain("/v1/rooms/session/recover");
  expect(page.url()).not.toContain("recover=");
  await expect(page.getByLabel("Photos or video")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ New capture", exact: true })).toHaveCount(0);
  await page.goto("/#admin");
  await expect(page.getByRole("heading", { name: "Permission required" })).toBeVisible();
});

test("a PLY uploader can view their owned photo sets without capture creation controls", async ({ page }) => {
  await page.route("**/v1/rooms/auth/me", route => route.fulfill({ json: account }));
  await page.route("**/v1/photo-captures", route => route.fulfill({ json: [{ id: "owned-capture", created_at: "2026-10-10T12:00:00Z", photo_count: 1, status: "photos_ready" }] }));
  await page.route("**/v1/photo-captures/owned-capture/photos/0", route => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9Y0AAAAASUVORK5CYII=", "base64") }));
  await page.goto("/#photos");
  await expect(page.getByRole("heading", { name: "Photo library", exact: true })).toBeVisible();
  await expect(page.getByText("1 photos", { exact: true })).toBeVisible();
  await expect(page.locator(".photo-workspace input[type=file]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Upload only", exact: true })).toHaveCount(0);
});

test("imported PLY opens an orbit viewer without GLTF, walking or tracking", async ({ page }) => {
  const properties = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
  const header = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex 2\n${properties.map(name => `property float ${name}\n`).join("")}end_header\n`);
  const payload = Buffer.alloc(2 * properties.length * 4);
  [[10, 3, -2, 0, 0, 0, 1, -3, -3, -3, 1, 0, 0, 0], [20, 7, 2, 0, 0, 0, 1, -3, -3, -3, 1, 0, 0, 0]].flat().forEach((value, i) => payload.writeFloatLE(value, i * 4));
  const bytes = Buffer.concat([header, payload]);
  const imported = { id: "imported-scene", name: "Imported garden", kind: "splat", state: "IMPORTED", stage: "imported", progress: 100, profile: "local", error: null, cancel_requested: false, diagnostics: {}, manifestUrl: "/v1/rooms/jobs/imported-scene/manifest", version: 1 };
  const manifest = { schemaVersion: 1, sceneId: imported.id, version: 1, sourceType: "gaussian-ply", ready: false, units: "uncalibrated", axes: "right-handed-y-up", worldFromReconstruction: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], previewCamera: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 15, 8, 18, 1], collisionReviewed: false, assets: { splats: { path: "room.ply", url: "/test-storage/room.ply", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length } } };
  const requests: string[] = [];
  await page.route("**/v1/rooms/**", route => {
    const path = new URL(route.request().url()).pathname; requests.push(path);
    return route.fulfill({ json: path.endsWith("/auth/me") ? account : path.endsWith("/manifest") ? manifest : path.endsWith("/jobs") ? [imported] : imported });
  });
  await page.route("**/test-storage/room.ply", route => route.fulfill({ body: bytes, contentType: "application/octet-stream" }));
  await page.goto("/#room-viewer?job=imported-scene");
  await expect(page.getByText("Imported PLY ready.", { exact: false })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "Start walking", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Edit room setup" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Top view", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Top view", exact: true }).click();
  await expect(page.getByRole("button", { name: "Fullscreen", exact: true })).toBeEnabled();
  await page.waitForTimeout(500);
  expect(requests.some(path => path.includes("/tracking"))).toBe(false);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
