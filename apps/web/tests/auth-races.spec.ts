import { expect, test, type Page } from "@playwright/test";
import { loginResponse, testAccount, testQuotaLimits } from "./auth-fixture";

async function signIn(page: Page) {
  await page.getByLabel("Username", { exact: true }).fill("tester");
  await page.getByLabel("Password", { exact: true }).fill("replacement-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("a delayed 401 from an earlier photo upload does not sign out a new session", async ({ page }) => {
  let finishUpload: (() => Promise<void>) | undefined;
  await page.route("**/v1/rooms/auth/**", route => route.fulfill({ status: route.request().url().endsWith("/logout") ? 204 : 200, ...(route.request().url().endsWith("/logout") ? {} : { json: route.request().url().endsWith("/login") ? loginResponse() : testAccount }) }));
  await page.route("**/v1/photo-captures", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: [] });
    finishUpload = () => route.fulfill({ status: 401, json: { detail: "Old session expired" } });
  });
  await page.goto("/#photos");
  await page.locator(".photo-workspace input[type=file]").setInputFiles({ name: "person.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9Y0AAAAASUVORK5CYII=", "base64") });
  await page.getByRole("button", { name: "Upload only", exact: true }).click();
  await expect.poll(() => !!finishUpload).toBe(true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Photo library", exact: true })).toBeVisible();
  await finishUpload!();
  await page.waitForTimeout(300);
  await expect(page.getByRole("heading", { name: "Photo library", exact: true })).toBeVisible();
});

test("a delayed self-account update response does not expire a newer login", async ({ page }) => {
  const admin = { ...testAccount, role: "ADMIN" };
  let finishUpdate: (() => Promise<void>) | undefined;
  await page.route("**/v1/rooms/auth/**", route => {
    if (new URL(route.request().url()).pathname.endsWith("/quota")) return route.fulfill({ json: testQuotaLimits });
    if (route.request().method() === "PATCH") { finishUpdate = () => route.fulfill({ json: admin }); return; }
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ status: path.endsWith("/logout") ? 204 : 200, ...(path.endsWith("/logout") ? {} : { json: path.endsWith("/users") ? [admin] : path.endsWith("/login") ? loginResponse(admin) : admin }) });
  });
  await page.goto("/#admin");
  const editor = page.getByRole("form", { name: "Edit tester", exact: true });
  await editor.getByLabel("New password", { exact: true }).fill("replacement-password");
  await editor.getByRole("button", { name: "Save account", exact: true }).click();
  await expect.poll(() => !!finishUpdate).toBe(true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
  await finishUpdate!();
  await page.waitForTimeout(300);
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
});

test("a delayed duplicate logout response does not clear a newer login", async ({ page }) => {
  const finishLogout: (() => Promise<void>)[] = [];
  await page.route("**/v1/rooms/auth/**", route => {
    if (route.request().url().endsWith("/logout")) { finishLogout.push(() => route.fulfill({ status: 204 })); return; }
    return route.fulfill({ json: route.request().url().endsWith("/login") ? loginResponse() : testAccount });
  });
  await page.goto("/#pipelines");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect.poll(() => finishLogout.length).toBe(2);
  await finishLogout[0]();
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Choose a pipeline", exact: true })).toBeVisible();
  await finishLogout[1]();
  await page.waitForTimeout(300);
  await expect(page.getByRole("heading", { name: "Choose a pipeline", exact: true })).toBeVisible();
});
