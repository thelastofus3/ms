import { expect, test } from "@playwright/test";
import { loginResponse, testAccessToken, testQuota } from "./auth-fixture";

const registered = { id: "registered-id", username: "new-user", role: "SPLAT_UPLOADER", disabled: false };

test("registration checks confirmation, retries a duplicate, and signs in with PLY-only access", async ({ page }) => {
  const submissions: unknown[] = [];
  await page.route("**/v1/rooms/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/v1/rooms/quota") return route.fulfill({ json: testQuota });
    if (path.endsWith("/auth/me")) return route.fulfill({ status: 401, json: { message: "Sign in required" } });
    if (path.endsWith("/auth/register")) {
      const credentials = request.postDataJSON(); submissions.push(credentials);
      return credentials.username === "taken-name"
        ? route.fulfill({ status: 409, json: { message: "Username is already in use" } })
        : route.fulfill({ status: 201, json: loginResponse(registered) });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto("/#rooms");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Register", exact: true })).toBeVisible();
  await expect(page.getByText("New accounts can import Gaussian PLY files.", { exact: false })).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await page.getByLabel("Username", { exact: true }).fill("taken-name");
  await page.getByLabel("Password", { exact: true }).fill("new-secure-password");
  await page.getByLabel("Confirm password", { exact: true }).fill("different-password");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Passwords do not match");
  expect(submissions).toEqual([]);
  await page.getByLabel("Confirm password", { exact: true }).fill("new-secure-password");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Username is already in use");
  await page.getByLabel("Username", { exact: true }).fill("  new-user  ");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.locator(".workspace-account")).toContainText("new-user");
  await expect(page.locator(".workspace-account")).toContainText("PLY uploader");
  await expect(page.getByLabel("Gaussian PLY file")).toBeVisible();
  await expect(page.getByLabel("Photos or video")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ New capture", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Accounts", exact: true })).toHaveCount(0);
  expect(submissions).toEqual([
    { username: "taken-name", password: "new-secure-password" },
    { username: "new-user", password: "new-secure-password" },
  ]);
  expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join(" "))).not.toContain(testAccessToken);
});

test("returning from registration clears errors and password fields before signing in", async ({ page }) => {
  await page.route("**/v1/rooms/auth/**", route => route.fulfill({ status: 401, json: { message: "Sign in required" } }));
  await page.goto("/#pipelines");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill("new-user");
  await page.getByLabel("Password", { exact: true }).fill("new-secure-password");
  await page.getByLabel("Confirm password", { exact: true }).fill("different-password");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Back to sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Confirm password", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByLabel("Confirm password", { exact: true })).toHaveValue("");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("registration controls remain reachable on narrow and low screens", async ({ page }) => {
  await page.route("**/v1/rooms/auth/me", route => route.fulfill({ status: 401, json: { message: "Sign in required" } }));
  for (const viewport of [{ width: 360, height: 640 }, { width: 768, height: 1024 }, { width: 1440, height: 480 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/#pipelines");
    await page.getByRole("button", { name: "Register", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Register", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    const confirm = page.getByLabel("Confirm password", { exact: true });
    await confirm.scrollIntoViewIfNeeded();
    await expect(confirm).toBeInViewport();
    const back = page.getByRole("button", { name: "Back to sign in", exact: true });
    await back.scrollIntoViewIfNeeded();
    await expect(back).toBeInViewport();
    await page.screenshot({ path: `../../.runtime/self-registration/registration-${viewport.width}x${viewport.height}.png`, fullPage: true });
    await back.click();
  }
});
